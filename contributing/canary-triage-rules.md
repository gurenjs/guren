# Canary Failure Triage Rules

This document defines how to respond when the nightly canary workflow fails.

## Severity Levels

### P0 — Blocking (fix within 24 hours)
- **Build failure**: `bun run build` fails → core framework is broken
- **Test regression**: previously passing tests now fail → code regression
- **Fresh app smoke failure**: `smoke:starter` fails → new users cannot scaffold apps

### P1 — High (fix within 48 hours)
- **Golden path smoke failure**: `smoke:golden-path` fails → primary workflow broken
- **Upgrade smoke failure**: `smoke:upgrade-existing-app` fails → upgrade path broken
- **Typecheck failure**: `bun run typecheck` fails → type regression

### P2 — Medium (fix within 1 week)
- **Audit failure**: any `audit:*` step fails → convention drift
- **Bundle budget failure**: `audit:bundle-budgets` fails → output size regression
- **Packed artifact failure**: `smoke:starter:packed` fails → npm packaging issue

### P3 — Low (fix in next sprint)
- **Docs audit failure**: `audit:docs` fails → documentation out of sync
- **Web app build failure**: web site build fails → docs site issue only

## Triage Process

1. **Check the nightly run**: Review the failed GitHub Actions run
2. **Identify the failing step**: Note which step failed first (earlier steps are higher priority)
3. **Reproduce locally**: Run the same command locally to confirm
4. **Check recent commits**: Use `git log --since="24 hours ago"` to find potential causes
5. **Open an issue**: Tag with `canary-failure` and the appropriate priority label
6. **Fix or revert**: For P0/P1, either fix forward or revert the offending commit

## Escalation

- P0 failures should be announced in the team channel immediately
- If a P0/P1 failure persists for 2+ days, consider reverting recent changes
- Recurring P2/P3 failures should be converted into backlog items

## Flaky Test Policy

- If a test fails intermittently (passes on retry), mark it as flaky
- Flaky tests must be fixed or quarantined within 1 week
- Do not disable flaky tests without opening a tracking issue

## Monitoring

- Nightly canary runs at 02:00 UTC daily
- Results are visible in GitHub Actions → "Nightly Canary" workflow
- Consider setting up Slack/email notifications for failures via GitHub Actions notification settings
