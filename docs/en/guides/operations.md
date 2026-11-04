# Production Operations Runbook

This runbook defines minimum reliability operations before GA.

## SLO Baseline

- API availability: **99.9% monthly**
- p95 response latency target: **< 300ms** for core routes
- Error budget policy: if budget is exhausted, prioritize reliability fixes over feature work

## Monitoring Minimum

- Health endpoint (`/health`) wired to load balancer checks
- Centralized logs from stdout/stderr
- Alerting for:
  - sustained 5xx rate
  - health check failures
  - queue backlog growth
  - database connection failures

## Backup Policy

- Daily automated PostgreSQL backups
- Retention policy (example): 7 daily, 4 weekly, 3 monthly
- Encrypt backups at rest and in transit
- Quarterly restore drill (must be documented)

## Incident Response

- Severity levels: SEV-1/SEV-2/SEV-3
- For SEV-1:
  - assign incident commander
  - communicate status every 30 minutes
  - mitigate first, then root-cause analysis
- Publish a postmortem for all SEV-1 incidents

## Deployment Safety Checks

Before production deploy:

```bash
bun run build
bun run typecheck
bun run test
```

After deploy:

- verify health checks
- verify migrations completed
- verify key user journeys

## Dependency Updates

A scaffolded app ships a `bunfig.toml` that holds back package versions published less than three days ago:

```toml
[install]
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = [
  "@guren/cli",
  "@guren/core",
  # every @guren package published when the app was scaffolded
]
```

Most compromised npm releases are found and pulled within hours or days, so an install that waits three days rarely picks one up. The gate applies whenever Bun resolves a version (`bun install` without a lockfile entry, `bun add`), for direct and transitive dependencies alike. A range that only versions younger than the gate satisfy fails the install with `blocked by minimum-release-age`; widen the range, or wait for the version to age. Versions already in `bun.lock` are not affected.

The `@guren` packages are listed by name, because Bun does not read a scope pattern such as `@guren/*` there, and an upgrade asks for Guren releases newer than the gate allows. The list covers every `@guren` package published when the app was scaffolded, plugins included; add a package published later the same way.

When a security fix is newer than three days, let that one version through instead of turning the gate off, then update:

```toml
minimumReleaseAgeExcludes = [
  # ...
  "some-package@1.2.4",
]
```

`guren doctor` reports `supply-chain-cooldown` when `bunfig.toml` sets no `minimumReleaseAge`, or when the list leaves out a `@guren` package the app has. `guren upgrade` writes the block, or adds the missing names, unless the file has an `[install]` table or a list it did not write; doctor then prints the line to add.

Run `guren audit` to see the advisories `bun audit` finds for the installed packages. To see which direct dependency brings a flagged package in, and whether production installs it, run `guren deps:why <package>`. `guren deps:exposure --package <package>` adds which routes reach it and whether it runs on the server or in the browser.

Under each advisory, `guren audit` lists the installed versions inside its affected ranges and the routes that reach each one, read from the same document as `deps:exposure`. A version reached only through `@guren` packages reads "reaches every route through @guren packages". One whose routes the readers could not settle reads "routes unknown", and the line after the findings names which reader was partial. An advisory with no installed version in range says why instead of showing nothing. With `--json`, each `deps:*` finding carries `advisory` (the GHSA and every affected range), `exposures` and, when that list is empty, `exposureReason`.

Each advisory with an installed version in range also comes with a fix. For a package the app declares, it is the lowest release outside the affected ranges, in the installed major when one exists. For a package another dependency brings in, it is the lowest release of that direct dependency whose tree leaves the ranges, and an override of the package when no release does. The audit then copies `package.json`, `bun.lock` and `bunfig.toml` to a temporary directory, applies the steps, and runs `bun install --lockfile-only` there. The fix reads `verified` only when the resolved lockfile has no version left in range. Because the copy keeps your release-age gate, a fixed version younger than three days is blocked there as it would be for you; the audit then adds a step naming the exact entry for `minimumReleaseAgeExcludes`, with its publish date, and resolves again. A fix the audit could not check reads `candidate` with the reason, for example in an app that shares a workspace lockfile. `--no-fix` skips the search, which reads the npm registry.

### Watching for new advisories

An advisory published after your last deploy goes unnoticed until someone runs the audit again. A scheduled workflow closes that gap. Commit the current report as a baseline:

```bash
bunx guren audit --json > audit-baseline.json
```

then run the audit against it every day:

```yaml
name: Dependency advisories
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bunx guren audit --deps-baseline audit-baseline.json
```

`--deps-baseline` exits 1 when an advisory finding's key is missing from the baseline, and when the dependency scan did not complete, so a registry outage fails the run instead of passing it. It reads a previous `guren audit --json` report or a JSON array of finding keys, at a path relative to the app. An advisory you ignore in `config/audit.ts` is never counted as new. The flag only adds exit conditions: a high or critical advisory still fails `guren audit` whether or not the baseline names it, so record one you have decided to live with in `config/audit.ts`, with the reason, and regenerate the baseline after each fix.
