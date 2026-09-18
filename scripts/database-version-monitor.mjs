#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY_PATH = join(REPO_ROOT, '.github', 'database-version-sources.json');
const USER_AGENT = 'chiron-horizon-database-version-monitor/1.0';
const SEMVER = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$/;

function parseVersion(version) {
  if (typeof version !== 'string' || !SEMVER.test(version)) throw new Error(`Expected a stable numeric version, got '${version}'.`);
  return version.split('.').map(Number);
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

export function validateRegistry(registry) {
  if (!registry || registry.schemaVersion !== 1 || !Array.isArray(registry.targets)) throw new Error('Invalid database version source registry.');
  const seen = new Set();
  for (const target of registry.targets) {
    if (!target?.id || seen.has(target.id)) throw new Error(`Target id must be unique: '${target?.id ?? ''}'.`);
    seen.add(target.id);
    parseVersion(target.currentVersion);
    if (typeof target.versionPrefix !== 'string' || !/^\d+(?:\.\d+)*\.$/.test(target.versionPrefix) || !target.currentVersion.startsWith(target.versionPrefix)) {
      throw new Error(`Target '${target.id}' must declare a versionPrefix containing its currentVersion.`);
    }
    if (!['docker-hub-image', 'crates-io-package'].includes(target.kind)) throw new Error(`Unsupported source kind for ${target.id}.`);
    if (!target.source || typeof target.source !== 'object') throw new Error(`Missing source for ${target.id}.`);
    if (!target.testSuite) throw new Error(`Missing test suite for ${target.id}.`);
    if (target.kind === 'docker-hub-image') {
      if (!target.source.repository || !target.image || !target.template || !target.database || !Array.isArray(target.portRange) || target.portRange.length !== 2) {
        throw new Error(`Incomplete Docker target '${target.id}'.`);
      }
    } else if (!target.source.crate || !target.manifest || !target.lockfile) {
      throw new Error(`Incomplete crate target '${target.id}'.`);
    }
  }
  return registry;
}

export function readRegistry(registryPath = DEFAULT_REGISTRY_PATH) {
  return validateRegistry(JSON.parse(readFileSync(registryPath, 'utf8')));
}

async function fetchJson(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}.`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function versionFromDockerTag(tag, target) {
  const prefix = target.source.tagPrefix ?? '';
  const suffix = target.source.tagSuffix ?? '';
  if (typeof tag !== 'string' || !tag.startsWith(prefix) || !tag.endsWith(suffix)) return null;
  const version = tag.slice(prefix.length, suffix ? -suffix.length : undefined);
  return SEMVER.test(version) && version.startsWith(target.versionPrefix) ? version : null;
}

export function newestDockerHubVersion(payload, target) {
  const versions = (payload?.results ?? []).map((tag) => versionFromDockerTag(tag?.name, target)).filter(Boolean);
  if (versions.length === 0) return null;
  return versions.reduce((latest, version) => compareVersions(version, latest) > 0 ? version : latest);
}

export function newestCratesVersion(payload, versionPrefix) {
  const version = payload?.crate?.newest_version;
  parseVersion(version);
  return version.startsWith(versionPrefix) ? version : null;
}

export async function resolveLatestVersion(target, fetchImpl = fetch) {
  if (target.kind === 'docker-hub-image') {
    const repository = encodeURIComponent(target.source.repository).replace('%2F', '/');
    const payload = await fetchJson(`https://hub.docker.com/v2/namespaces/${repository.split('/')[0]}/repositories/${repository.split('/')[1]}/tags?page_size=100&ordering=last_updated`, fetchImpl);
    return newestDockerHubVersion(payload, target);
  }
  if (target.kind === 'crates-io-package') {
    const payload = await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(target.source.crate)}`, fetchImpl);
    return newestCratesVersion(payload, target.versionPrefix);
  }
  throw new Error(`Unsupported source kind '${target.kind}'.`);
}

export async function findUpdate(registry, targetId, fetchImpl = fetch) {
  const targets = targetId && targetId !== 'all' ? registry.targets.filter((target) => target.id === targetId) : registry.targets;
  if (targets.length === 0) throw new Error(`Unknown target '${targetId}'.`);
  const proposals = [];
  for (const target of targets) {
    const latestVersion = await resolveLatestVersion(target, fetchImpl);
    if (latestVersion && compareVersions(latestVersion, target.currentVersion) > 0) {
      proposals.push({ id: target.id, kind: target.kind, currentVersion: target.currentVersion, latestVersion, testSuite: target.testSuite });
    }
  }
  return proposals;
}

function nextPort(root, target) {
  const [start, end] = target.portRange;
  const databaseDirectory = join(root, 'deploy', 'database', target.database);
  const used = new Set();
  if (existsSync(databaseDirectory)) {
    for (const version of readdirSync(databaseDirectory)) {
      const recipePath = join(databaseDirectory, version, 'recipe.json');
      if (!existsSync(recipePath)) continue;
      const recipe = JSON.parse(readFileSync(recipePath, 'utf8'));
      for (const port of Object.values(recipe.hostPorts ?? {})) used.add(port);
    }
  }
  for (let port = start; port <= end; port += 1) if (!used.has(port)) return port;
  throw new Error(`No free host port remains for ${target.id}.`);
}

function replaceExact(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Could not update ${label}; expected '${before}'.`);
  return source.split(before).join(after);
}

function updateServerTarget(root, registryPath, registry, target, latestVersion) {
  const templateDirectory = join(root, target.template);
  const templateRecipePath = join(templateDirectory, 'recipe.json');
  const templateComposePath = join(templateDirectory, 'compose.yaml');
  if (!existsSync(templateRecipePath) || !existsSync(templateComposePath)) throw new Error(`Missing recipe template for ${target.id}.`);
  const templateRecipe = JSON.parse(readFileSync(templateRecipePath, 'utf8'));
  const targetDirectory = join(root, 'deploy', 'database', target.database, latestVersion);
  if (existsSync(targetDirectory)) throw new Error(`${target.id} ${latestVersion} already has a recipe.`);
  const port = nextPort(root, target);
  const image = `${target.image}:${target.imageTagPrefix ?? ''}${latestVersion}${target.imageTagSuffix ?? ''}`;
  mkdirSync(dirname(targetDirectory), { recursive: true });
  cpSync(templateDirectory, targetDirectory, { recursive: true });
  const recipe = JSON.parse(readFileSync(join(targetDirectory, 'recipe.json'), 'utf8'));
  recipe.version = latestVersion;
  recipe.displayVersion = latestVersion;
  recipe.image = image;
  recipe.connection.port = port;
  recipe.hostPorts.DB_PORT = port;
  writeFileSync(join(targetDirectory, 'recipe.json'), `${JSON.stringify(recipe, null, 2)}\n`);
  let compose = readFileSync(join(targetDirectory, 'compose.yaml'), 'utf8');
  compose = replaceExact(compose, templateRecipe.image, image, `${target.id} image`);
  compose = replaceExact(compose, `chiron-horizon-${target.database}-${templateRecipe.displayVersion}`, `chiron-horizon-${target.database}-${latestVersion}`, `${target.id} container name`);
  compose = replaceExact(compose, `DB_PORT:-${templateRecipe.connection.port}`, `DB_PORT:-${port}`, `${target.id} port`);
  writeFileSync(join(targetDirectory, 'compose.yaml'), compose);
  const nextRegistry = JSON.parse(JSON.stringify(registry));
  nextRegistry.targets.find((item) => item.id === target.id).currentVersion = latestVersion;
  writeFileSync(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`);
  return [
    join('deploy', 'database', target.database, latestVersion, 'recipe.json'),
    join('deploy', 'database', target.database, latestVersion, 'compose.yaml'),
    join('deploy', 'database', target.database, latestVersion, 'init'),
    '.github/database-version-sources.json',
  ];
}

function updateCrateTarget(root, registryPath, registry, target, latestVersion, runCommand) {
  const manifestPath = join(root, target.manifest);
  const previous = readFileSync(manifestPath, 'utf8');
  const pattern = /duckdb\s*=\s*\{\s*version\s*=\s*"([^"]+)"/;
  if (!pattern.test(previous)) throw new Error(`Could not find duckdb dependency in ${target.manifest}.`);
  writeFileSync(manifestPath, previous.replace(pattern, `duckdb = { version = "${latestVersion}"`));
  runCommand('cargo', ['update', '--manifest-path', target.manifest, '-p', 'duckdb', '--precise', latestVersion], root);
  const nextRegistry = JSON.parse(JSON.stringify(registry));
  nextRegistry.targets.find((item) => item.id === target.id).currentVersion = latestVersion;
  writeFileSync(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`);
  return [target.manifest, target.lockfile, '.github/database-version-sources.json'];
}

function defaultRunCommand(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

export function applyProposal({ root, registryPath, registry, proposal, runCommand = defaultRunCommand }) {
  const resolvedRoot = root ? resolve(root) : resolve(dirname(registryPath ?? DEFAULT_REGISTRY_PATH), '..');
  const resolvedRegistryPath = registryPath ? resolve(registryPath) : join(resolvedRoot, '.github', 'database-version-sources.json');
  const resolvedRegistry = registry ?? readRegistry(resolvedRegistryPath);
  const target = resolvedRegistry.targets.find((item) => item.id === proposal.id);
  if (!target) throw new Error(`Unknown target '${proposal.id}'.`);
  if (proposal.currentVersion !== target.currentVersion) throw new Error(`Proposal for ${proposal.id} is stale.`);
  if (compareVersions(proposal.latestVersion, target.currentVersion) <= 0) throw new Error(`Proposal for ${proposal.id} is not an upgrade.`);
  const changedFiles = target.kind === 'docker-hub-image'
    ? updateServerTarget(resolvedRoot, resolvedRegistryPath, resolvedRegistry, target, proposal.latestVersion)
    : updateCrateTarget(resolvedRoot, resolvedRegistryPath, resolvedRegistry, target, proposal.latestVersion, runCommand);
  return { ...proposal, changedFiles };
}

function argumentValue(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const mode = argumentValue(args, '--mode', 'check');
  const targetId = argumentValue(args, '--target', 'all');
  const output = argumentValue(args, '--output');
  const registryPath = resolve(argumentValue(args, '--registry', DEFAULT_REGISTRY_PATH));
  const registry = readRegistry(registryPath);
  const proposals = await findUpdate(registry, targetId);
  if (mode === 'check') {
    const result = { status: proposals.length ? 'update_available' : 'no_update', proposals };
    if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
    else console.log(JSON.stringify(result));
    return;
  }
  if (mode !== 'propose') throw new Error(`Unknown mode '${mode}'.`);
  if (proposals.length !== 1) throw new Error('Proposal mode requires exactly one target with an available update.');
  const result = applyProposal({ registryPath, registry, proposal: proposals[0] });
  if (output) writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  else console.log(JSON.stringify(result));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`database version monitor failed: ${error.message}`);
    process.exitCode = 1;
  });
}
