# Issue Triage and SLAs

This document defines how issues are prioritized, labeled, and resolved.

## Priority Levels

### P0 -- Critical

Security vulnerability, data loss, or complete breakage affecting all users.

- **Response:** within 24 hours
- **Fix target:** within 48 hours
- **Label:** `priority:critical`
- **Examples:** authentication bypass, database corruption, package fails to import

### P1 -- High

Major feature broken with no reasonable workaround, blocking common workflows.

- **Response:** within 48 hours
- **Fix target:** within 1 week
- **Label:** `priority:high`
- **Examples:** routing fails for a supported pattern, ORM queries return incorrect results

### P2 -- Medium

Minor feature broken or degraded, but a workaround exists.

- **Response:** within 1 week
- **Fix target:** within 2 weeks
- **Label:** `priority:medium`
- **Examples:** CLI flag not working (manual alternative exists), incorrect error message

### P3 -- Low

Enhancement request, cosmetic issue, or minor inconvenience.

- **Response:** within 2 weeks
- **Fix target:** scheduled for next minor release
- **Label:** `priority:low`
- **Examples:** better error messages, documentation gaps, nice-to-have CLI features

## Labels

In addition to priority labels, issues are tagged with:

| Label | Description |
|-------|-------------|
| `bug` | Confirmed defect in existing behavior |
| `feature` | Request for new functionality |
| `docs` | Documentation improvement |
| `good first issue` | Suitable for new contributors |
| `help wanted` | Maintainers welcome external contributions |
| `needs reproduction` | Bug report lacks reproduction steps |
| `duplicate` | Already tracked in another issue |
| `wontfix` | Intentional behavior or out of scope |

## Triage Process

1. **New issues** are reviewed by a maintainer who assigns a priority label and any relevant category labels.
2. **Needs reproduction** is applied if the report lacks sufficient detail. The reporter has 14 days to provide reproduction steps before the issue is closed.
3. **Duplicate** issues are closed with a link to the original.
4. **Accepted** issues are added to the appropriate milestone.

## Stale Policy

- Issues with no activity for **30 days** receive a stale warning comment.
- Issues with no activity for **60 days** after the warning are closed automatically.
- Closed stale issues can be reopened if new information is provided.
- Issues labeled `priority:critical` or `priority:high` are exempt from the stale policy.

## Regression Test Requirement

All bug fix pull requests **must** include a regression test that:

1. **Fails** without the fix applied (demonstrates the bug)
2. **Passes** with the fix applied (proves the fix works)

Pull requests that fix bugs without a regression test will not be merged unless the maintainer explicitly waives this requirement (e.g., for issues that are impractical to test in isolation).

This policy ensures that fixed bugs do not resurface in future releases.
