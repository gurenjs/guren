---
type: adr
status: stable
entities: []
related:
  - app/Http/Middleware/site-analytics.ts
  - scripts/analytics-report.ts
  - wrangler.jsonc
verified: { by: human:7nohe, at: 2026-11-21T13:19:14Z }
---

# Analytics are server-side and cookie-less

## Context

The site needed referrer and page data before it was promoted. Its readers
run ad blockers that drop client-side beacons. The AI agents that fetch the
markdown mirrors and `llms.txt` run no JavaScript at all, so their share of
the traffic exists only on the server.

## Decision

A middleware writes one data point to Workers Analytics Engine for each
request that reaches the Worker.
It stores the path, a visitor class (human, AI agent, bot, unknown), the
referrer's host, the primary language, the country, the status and the
duration.

It stores no cookie, no IP address, no full referrer URL and no full user
agent. The middleware is registered after the canonical-host redirect and
records in `finally`, so a redirect to the bare host is not counted and an
error response is.

## Consequences

The site sets no analytics cookie and shows no consent banner.

There are no sessions or unique visitors in the data, only requests. A
visitor class is a guess from the user agent, and the matched token is
stored so an over-broad pattern can be seen and narrowed.

A request the asset layer answers before the Worker is not recorded. Since
ADR 0002 that covers the `.md` mirrors and `llms-full.txt`, so the agent
traffic counted is what reaches the Worker: `llms.txt` and the HTML pages.

Without the binding (Bun development, tests) the middleware does nothing.
The free plan allows 100,000 data points a day.
