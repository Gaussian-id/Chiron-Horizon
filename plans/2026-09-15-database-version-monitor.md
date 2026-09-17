# Database Version Monitor Plan

## Goal

Add an internal GitHub Actions automation that discovers supported database and driver releases, proposes a single-purpose pull request for each compatible update, and proves the update through CI before a maintainer merges it.

The automation belongs in the Chiron Horizon repository. A separate bot repository is not part of v1. The designated self-hosted Linux runner executes the scheduled monitor and pull-request checks, including Docker-based database compatibility tests.

The pilot uses the repository-provided `GITHUB_TOKEN`, so it needs no GitHub App, App ID, private key, personal access token, or new secret. GitHub marks pull-request workflows created by `GITHUB_TOKEN` as approval-required; a maintainer with write access approves the compatibility run from the PR. A GitHub App is an optional post-pilot improvement only if fully unattended PR CI is required.

## Scope and policy

Start with three targets, each exercising a different source type:

| Target | Update being monitored | Authoritative source | Repository change |
| --- | --- | --- | --- |
| PostgreSQL | Latest stable server release | Official PostgreSQL Docker image / official release feed | Add a pinned Compose recipe and compatibility test target |
| MySQL | Latest stable server release | Official MySQL Docker image / official release feed | Add a pinned Compose recipe and compatibility test target |
| DuckDB | Rust client library release | crates.io `duckdb` package | Update Cargo dependency and lockfile, then run driver tests |

The monitor accepts stable semantic versions only. It rejects prereleases, `latest` image tags, mutable tags without a digest, unparsable versions, downgrades, and releases outside a configured support channel. Existing supported recipes are never overwritten: a new server version adds a new recipe so regression coverage is preserved.

The automation creates or updates a pull request but never merges it. A maintainer owns the compatibility claim by reviewing and merging the PR.

This is a pilot, not a rollout to every supported database. PostgreSQL, MySQL, and DuckDB are the only enabled targets until the pilot exit criteria below are met. Later databases are added in source-compatible batches after the pilot, beginning with public Docker-image targets and then package-managed drivers; private, licensed, and network-dependent databases remain opt-in.

## Implementation

### Version source registry and monitor

Add `.github/database-version-sources.json` as the source of truth. Each entry defines the database id, update kind (`server-image` or `package`), source URL/API, stable-version policy, currently supported version, target files, and CI suite name. The initial entries are PostgreSQL, MySQL, and DuckDB.

Add `scripts/database-version-monitor.mjs`, with unit tests, to:

1. Load and validate the registry.
2. Fetch only the configured vendor source using a short timeout and an explicit User-Agent.
3. Select the newest allowed stable version, compare it with the recorded version, and exit successfully with a machine-readable `no_update` result when unchanged.
4. In proposal mode, update exactly one target: pin server-image recipes to an exact stable version tag or update the declared package plus lockfile. Docker manifest digests are deferred because the current multi-architecture recipe format needs a manifest-list resolver.
5. Emit a JSON proposal containing target, old/new version, source URL, changed files, and requested test suite.

Add `.github/workflows/database-version-monitor.yml`. It runs every Monday at 02:00 Asia/Jakarta (`0 19 * * 0` UTC), supports manual dispatch for one configured target, and calls the monitor in check mode. When an update exists it creates or refreshes `bot/database-version/<target>-<version>`, commits only the generated proposal, and opens or updates one labelled PR. A concurrency key prevents duplicate PRs for the same target/version.

The monitor uses `GITHUB_TOKEN` as `github-actions[bot]` with job-scoped `contents: write` and `pull-requests: write`; all other permissions stay `none`. The repository administrator must enable read/write workflow permissions and allow GitHub Actions to create pull requests in repository Actions settings. The bot has no approval or merge permission.

Because GitHub requires approval before running `pull_request` workflows created by `GITHUB_TOKEN`, the designated target owner approves the compatibility CI once per bot PR. The workflow must state this explicitly in the PR body. A GitHub App with the same least-privilege scopes is optional after the pilot if eliminating that approval is worth the additional administrative setup.

### Compatibility CI

Keep the current database-environment validation workflow for recipe structure. Add `.github/workflows/database-compatibility.yml`, triggered for monitor PRs and manual dispatch.

For PostgreSQL and MySQL, the workflow selects the PR's generated recipe, runs `pnpm db:env -- verify <database> <version>`, then executes a Chiron Horizon connection suite against that container. The suite must prove: authenticated connection, schema/metadata discovery, create/read/update/delete, one transaction rollback, and clean shutdown. It must publish Docker logs and the test report on failure, and always tear down the Compose project.

For DuckDB, the workflow runs the affected Rust driver and core connection tests after the dependency lockfile is updated. It does not treat a successful dependency resolution as compatibility proof.

The monitor PR is considered ready only when existing PR verification and its target compatibility suite pass. Failed checks leave the PR open with logs; the bot neither retries indefinitely nor creates a second PR for the same target/version.

### Release and client delivery

After a reviewed merge, the normal release owner decides when to create the agent/application release tag. Agent-driver changes use the existing agent-release path to publish the versioned artifact and refresh `agent-registry.json`; the desktop Driver Store already reads this registry and exposes an available update.

A database server recipe alone does not publish an app update or claim global support. It establishes verified compatibility in the repository. Any agent or desktop binary change follows its normal release process.

## Test plan and acceptance criteria

- Unit tests cover registry validation, stable-version selection, prerelease rejection, immutable Docker digest handling, unchanged target output, and one update proposal per target/version.
- Workflow tests prove that a scheduled no-change run creates no branch or PR, while a simulated update creates one correctly named PR with source and version details.
- PostgreSQL and MySQL monitor PRs pass the Compose health check, bootstrap/smoke checks, and the end-to-end connection suite.
- DuckDB monitor PRs pass the affected driver/core tests and preserve a reproducible lockfile.
- A failed image pull, vendor API error, invalid response, or failing test produces a visible failed workflow without modifying `main`, tagging a release, or merging a PR.

## Pilot exit and expansion

The pilot is successful only when all of the following are true:

1. Each of PostgreSQL, MySQL, and DuckDB has completed one end-to-end proposal using a controlled update fixture or a real upstream update: detection, one bot PR, required CI, maintainer review, merge, and the applicable release path.
2. Four consecutive scheduled runs complete without duplicate PRs, unintended repository mutations, secret exposure, or unresolved workflow failures.
3. The compatibility suites catch one intentionally introduced incompatible image/dependency fixture, proving that a green PR is meaningful rather than merely buildable.
4. Maintainers approve the bot PR format, source links, test logs, run cost, and review workload.

After all gates pass, add targets in batches of five and repeat the first end-to-end proposal for every new source adapter. Do not enable all databases in one change: the current project includes public images, native drivers, Java/JDBC agents, message queues, and vendor-specific services that need different source and test adapters.

## Required setup before implementation

1. A repository administrator enables read/write workflow permissions and allows GitHub Actions to create pull requests in Chiron Horizon's Actions settings. No secret or GitHub App is required for the pilot.
2. Configure branch protection so merge still needs at least one maintainer approval and passing checks; a maintainer must approve each `GITHUB_TOKEN`-created PR workflow before its compatibility CI runs.
3. Confirm the designated self-hosted Linux runner is Docker-capable and can pull public PostgreSQL and MySQL images.
4. Nominate an owner for each initial target to review compatibility PRs and define the supported release channel. Default: latest stable GA version, retaining the existing supported major versions.
5. Later targets that depend on private registries, paid vendor images, or internal networks are added only after a self-hosted runner and its credentials are approved.
