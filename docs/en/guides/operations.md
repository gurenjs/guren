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

`guren doctor` reports `supply-chain-cooldown` when `bunfig.toml` sets no `minimumReleaseAge`, or when the list leaves out a `@guren` package the app has. `guren upgrade` writes the block, or adds the missing names, unless the file has an `[install]` table or a list it did not write; doctor then prints the line to add. Bun reads `minimumReleaseAge` from 1.3.0 and older releases install past it without a word, so doctor also warns when the running Bun, `engines.bun`, `packageManager` or an `oven/bun` image names an older release.

Run `guren audit` to see the advisories `bun audit` finds for the installed packages. To see which direct dependency brings a flagged package in, and whether production installs it, run `guren deps:why <package>`. `guren deps:exposure --package <package>` adds which routes reach it and whether it runs on the server or in the browser.

The files the server entry (`src/main.ts`, `bin/serve.ts`) loads at boot, such as `src/app.ts`, the routes files, `config/` and middleware files, run on every route, so a package they import is attributed to every route. Seeders, console commands and `resources/js/dev-entry.ts` run only from the CLI or the Vite dev server and are placed `build`. Middleware built inline in a routes file (`requireGuest({ … })`) has no identity in the graph, but the code it runs comes from a package or a file loaded at boot, so it does not leave the result partial. Middleware exported from a controller or model file is the exception: it is attributed only to that file's routes.

Under each advisory, `guren audit` lists the installed versions inside its affected ranges and the routes that reach each one, read from the same document as `deps:exposure`. A version reached only through `@guren` packages reads "reaches every route through @guren packages". One whose routes the readers could not settle reads "routes unknown", and the section that ends the report names which reader was partial. An advisory with no installed version in range says why instead of showing nothing. With `--json`, each `deps:*` finding carries `advisory` (the GHSA and every affected range), `exposures` and, when that list is empty, `exposureReason`.

Each advisory with an installed version in range also comes with a fix. For a package the app declares, it is the lowest release outside the affected ranges, in the installed major when one exists. For a package another dependency brings in, it is the lowest release of that direct dependency whose tree leaves the ranges, and an override of the package when no release does. The audit then copies `package.json`, `bun.lock` and `bunfig.toml` to a temporary directory, applies the steps, and runs `bun install --lockfile-only` there. The fix reads `verified` only when the resolved lockfile has no version left in range. Because the copy keeps your release-age gate, a fixed version younger than three days is blocked there as it would be for you; the audit then adds a step naming the exact entry for `minimumReleaseAgeExcludes`, with its publish date, and resolves again. A fix the audit could not check reads `candidate` with the reason, for example in an app that shares a workspace lockfile. `--no-fix` skips the search, which reads the npm registry.

`bun audit` covers npm packages, not Bun itself, so `guren audit` also checks the Bun versions the app runs on: the Bun running the command, `engines.bun` and `packageManager` in `package.json`, and the `oven/bun` images in the Dockerfiles at the app root. Each one is matched against the advisories in the `oven-sh/bun` repository, which the databases `bun audit` reads have not always carried, and against GitHub's advisory database for the npm package `bun`, which has held one the repository does not. A version inside an advisory's range is a `deps:runtime:<GHSA>` finding naming the patched release; a canary counts as the release it precedes. An image reference that names no exact release (`oven/bun:1`) or carries no digest is a `deps:runtime-unpinned` warning, since a rebuild can pick up another Bun; `guren deploy` writes `oven/bun:<version>@sha256:…`. The advisories come from `api.github.com`, which allows 60 requests an hour without a token; set `GITHUB_TOKEN` in CI. When either source cannot be read, the audit reports `deps:runtime-scan` rather than a clean result. `guren deps:exposure` prints the same versions under "Bun runtime".

`guren audit` and `guren deps:exposure` both end with "What these results rest on without checking". The section is built from what the run read, so it never lists a check the run skipped; under `--no-deps` it says the runtime was not checked. It names:

- the sources of Bun's own advisories (`oven-sh/bun`'s repository and GitHub's advisory database, or the one that was read) and any version or image tag that names no exact release;
- how many packages no app import reaches except through `@guren` packages, which no route is attributed to;
- each reader that stopped short in this run, such as an import that resolves to no file, each graph entry left unresolved (with its relation and target), or a response value the column rule could not follow;
- each fix left as `candidate`, with its reason;
- the lockfile's integrity hashes, which Bun checks at install and Guren does not.

`--json` carries the same entries under `trustBoundary`, each with `from` (the reader or step) and `message`.

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
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`--deps-baseline` exits 1 when an advisory finding's key, a Bun runtime one included, is missing from the baseline, and when the dependency scan or the runtime check did not complete, so an outage fails the run instead of passing it. It reads a previous `guren audit --json` report or a JSON array of finding keys, at a path relative to the app. An advisory you ignore in `config/audit.ts` is never counted as new. The flag only adds exit conditions: a high or critical advisory still fails `guren audit` whether or not the baseline names it, so record one you have decided to live with in `config/audit.ts`, with the reason, and regenerate the baseline after each fix.
