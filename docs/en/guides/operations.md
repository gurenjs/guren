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
