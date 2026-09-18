import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyProposal, compareVersions, findUpdate, newestCratesVersion, newestDockerHubVersion, validateRegistry } from './database-version-monitor.mjs';

function target(id, kind, currentVersion) {
  if (kind === 'docker-hub-image') {
    return {
      id,
      database: id,
      kind,
      currentVersion,
      versionPrefix: `${currentVersion.split('.').slice(0, -1).join('.')}.`,
      source: { repository: `library/${id}` },
      image: id === 'postgresql' ? 'postgres' : id,
      template: `deploy/database/${id}/${currentVersion}`,
      portRange: [10300, 10302],
      testSuite: id,
    };
  }
  return { id, kind, currentVersion, versionPrefix: `${currentVersion.split('.').slice(0, -1).join('.')}.`, source: { crate: id }, manifest: 'agents/drivers/duckdb/Cargo.toml', lockfile: 'agents/drivers/duckdb/Cargo.lock', testSuite: id };
}

function serverFixture() {
  const root = mkdtempSync(join(tmpdir(), 'chiron-horizon-version-monitor-'));
  const recipeDirectory = join(root, 'deploy', 'database', 'postgresql', '17.4');
  mkdirSync(join(recipeDirectory, 'init'), { recursive: true });
  mkdirSync(join(root, '.github'), { recursive: true });
  writeFileSync(join(recipeDirectory, 'init', '001.sql'), 'SELECT 1;\n');
  writeFileSync(join(recipeDirectory, 'recipe.json'), JSON.stringify({
    database: 'postgresql', name: 'PostgreSQL', version: '17.4', displayVersion: '17.4', image: 'postgres:17.4', service: 'database',
    connection: { port: 10300 }, hostPorts: { DB_PORT: 10300 },
  }, null, 2));
  writeFileSync(join(recipeDirectory, 'compose.yaml'), 'services:\n  database:\n    image: postgres:17.4\n    container_name: chiron-horizon-postgresql-17.4\n    ports:\n      - "${DB_BIND_ADDRESS:-127.0.0.1}:${DB_PORT:-10300}:5432"\n');
  const registry = { schemaVersion: 1, targets: [target('postgresql', 'docker-hub-image', '17.4')] };
  const registryPath = join(root, '.github', 'database-version-sources.json');
  writeFileSync(registryPath, JSON.stringify(registry));
  return { root, registry, registryPath };
}

test('compares numeric versions including different precision', () => {
  assert.equal(compareVersions('18.1', '17.9'), 1);
  assert.equal(compareVersions('8.4.6', '8.4.6'), 0);
  assert.equal(compareVersions('1.3.2', '1.3'), 1);
  assert.throws(() => compareVersions('latest', '1.0'), /stable numeric/);
});

test('chooses only stable numeric versions in the configured support channel', () => {
  const postgresql = target('postgresql', 'docker-hub-image', '17.4');
  assert.equal(newestDockerHubVersion({ results: [{ name: '18.1' }, { name: '17.9' }, { name: '17.10-bookworm' }, { name: 'latest' }] }, postgresql), '17.9');
  assert.equal(newestDockerHubVersion({ results: [{ name: 'latest' }, { name: '18.1-rc1' }] }, postgresql), null);
  assert.equal(newestCratesVersion({ crate: { newest_version: '1.4.0' } }, '1.3.'), null);
});

test('validates target source requirements', () => {
  assert.doesNotThrow(() => validateRegistry({ schemaVersion: 1, targets: [target('postgresql', 'docker-hub-image', '17.4')] }));
  assert.throws(() => validateRegistry({ schemaVersion: 1, targets: [target('postgresql', 'unsupported', '17.4')] }), /Unsupported source kind/);
});

test('discovers updates and leaves current versions alone', async () => {
  const registry = { schemaVersion: 1, targets: [target('postgresql', 'docker-hub-image', '17.4'), target('duckdb', 'crates-io-package', '1.3.2')] };
  const fetchImpl = async (url) => ({ ok: true, json: async () => url.includes('postgres') ? { results: [{ name: '17.4' }, { name: '17.9' }, { name: '18.1' }] } : { crate: { newest_version: '1.3.2' } } });
  assert.deepEqual(await findUpdate(registry, 'all', fetchImpl), [{ id: 'postgresql', kind: 'docker-hub-image', currentVersion: '17.4', latestVersion: '17.9', testSuite: 'postgresql' }]);
});

test('creates an isolated server recipe and advances its registry cursor', () => {
  const { root, registry, registryPath } = serverFixture();
  const result = applyProposal({ registryPath, registry, proposal: { id: 'postgresql', currentVersion: '17.4', latestVersion: '18.1', testSuite: 'postgresql' } });
  assert.deepEqual(result.changedFiles.slice(0, 2), ['deploy/database/postgresql/18.1/recipe.json', 'deploy/database/postgresql/18.1/compose.yaml']);
  const recipe = JSON.parse(readFileSync(join(root, 'deploy', 'database', 'postgresql', '18.1', 'recipe.json')));
  assert.equal(recipe.version, '18.1');
  assert.equal(recipe.image, 'postgres:18.1');
  assert.equal(recipe.connection.port, 10301);
  assert.match(readFileSync(join(root, 'deploy', 'database', 'postgresql', '18.1', 'compose.yaml'), 'utf8'), /chiron-horizon-postgresql-18\.1/);
  assert.equal(JSON.parse(readFileSync(registryPath)).targets[0].currentVersion, '18.1');
});
