import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .toString()
      .split("\0")
      .filter(Boolean),
  ),
];
const excluded = /^(vendor\/|\.github\/disabled-workflows\/|scripts\/disabled-release\/)/;
// These are the only owned files allowed to retain an old name: migration
// adapters, documented provenance, and their tests. Dependency identities and
// licenses are intentionally outside the product-name scan.
const compatibility = new Set([
  "agents/go-common/go-gssapi/krb5/legacy_env.go",
  "agents/go-common/gosasl/legacy_env.go",
  "packages/mcp-server/bin/legacy-environment.js",
  "packages/plugin-cli/bin/legacy-environment.js",
  "crates/chiron-horizon-core/src/legacy.rs",
  "src-tauri/src/data_dir.rs",
  "README.md",
  "docs/development/white-label.md",
  "scripts/audit-branding.mjs",
  "scripts/stage-desktop-release.mjs",
  "agents/scripts/verify_release_assets.py",
]);
const failures = [];
let checked = 0;
for (const file of files) {
  if (!existsSync(file) || excluded.test(file) || /(?:LICENSE|NOTICE)/i.test(file) || compatibility.has(file) || file.startsWith("apps/desktop/src/lib/compat/")) continue;
  const bytes = readFileSync(file);
  if (bytes.includes(0) || file.endsWith("go.sum")) continue;
  const text = bytes.toString("utf8");
  checked++;
  for (const [index, line] of text.split("\n").entries()) {
    const normalized = line
      .replace(/data:[^\s"<>;]+;base64,[A-Za-z0-9+/=]+/g, "")
      .replace(/integrity:.*\r?$/, "")
      // The existing remote has not been renamed. Preserve its address until
      // the repository itself moves, while still rejecting old local identity.
      .replace(/Gaussian-id\/Gauss-Horizon/g, "");
    if (/dbx|dbxio/i.test(normalized)) failures.push(`${file}:${index + 1}: legacy product reference`);
    if (/\bgauss(?:[ _-]?horizon|_horizon)\b|\bgausshorizon\b/i.test(normalized)) {
      failures.push(`${file}:${index + 1}: former product identity`);
    }
    if (/https?:\/\/[^\s"'<>]*(?:chiron-horizonio\.com|t8y2\/(?:dbx|scoop-bucket|tap))/i.test(line)) failures.push(`${file}:${index + 1}: obsolete distribution URL`);
  }
}

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
if (config.productName !== "Chiron Horizon" || config.version !== "0.1.0" || config.identifier !== "id.chiron.horizon") {
  failures.push("Unexpected application identity");
}
if (config.plugins.updater || config.bundle.createUpdaterArtifacts) failures.push("Updater configuration must be absent/disabled");

const workflows = readdirSync(".github/workflows").sort();
const expectedWorkflows = new Set(["verify.yml", "release.yml", "database-version-monitor.yml"]);
for (const file of workflows) if (!expectedWorkflows.has(file)) failures.push(`Unreviewed active workflow: ${file}`);
for (const file of expectedWorkflows) if (!workflows.includes(file)) failures.push(`Required workflow missing: ${file}`);

if (workflows.includes("verify.yml")) {
  const verify = readFileSync(".github/workflows/verify.yml", "utf8");
  if (!/contents:\s*read/.test(verify)) failures.push("Verification workflow must be read-only");
  if (/contents:\s*write|gh\s+release|git\s+push|docker\s+push|(?:pnpm|npm)\s+publish/i.test(verify)) {
    failures.push("Verification workflow contains publication or mutation");
  }
}

if (workflows.includes("release.yml")) {
  const release = readFileSync(".github/workflows/release.yml", "utf8");
  if (!/tags:\s*\["v\*"\]/.test(release) || /workflow_dispatch|pull_request/.test(release)) {
    failures.push("Release workflow must run only for v* tags");
  }
  if (!/contents:\s*write/.test(release)) failures.push("Release workflow needs only GitHub Release contents: write permission");
  if (!/gh\s+release\s+create/.test(release)) failures.push("Release workflow must create the GitHub Release after validation");
  if (/\b(?:pnpm|npm)\s+publish\b|\bdocker\s+(?:push|login|buildx)\b|\bgit\s+push\b|\bgh\s+api\b|latest\.json|createUpdaterArtifacts\s*:\s*true|cloudflare|r2|cnb|mirror/i.test(release)) {
    failures.push("Release workflow enables a forbidden distribution, mirror, updater, or repository mutation");
  }
}

if (workflows.includes("database-version-monitor.yml")) {
  const monitor = readFileSync(".github/workflows/database-version-monitor.yml", "utf8");
  if (!/contents:\s*write/.test(monitor) || !/pull-requests:\s*write/.test(monitor)) {
    failures.push("Database monitor needs contents and pull-request write permissions to create proposals");
  }
  if (!/schedule:/.test(monitor) || !/workflow_dispatch:/.test(monitor)) {
    failures.push("Database monitor must support scheduled and manual runs");
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Branding audit passed: ${checked} owned text files; compatibility/licensing exceptions documented; verification is read-only and release is tag-only.`);
}
