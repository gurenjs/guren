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

Run `guren audit` to see the advisories `bun audit` finds for the installed packages.
