# Support Matrix

## Runtime

| Runtime | Versions | Status |
|---------|----------|--------|
| Bun     | 1.3.x    | Supported (CI-tested) |
| Bun     | 1.4.x    | Planned |
| Node.js | 22.x     | Lambda only (via `createLambdaHandler`) |

## Database

| Database   | Versions | Status |
|------------|----------|--------|
| PostgreSQL | 14+      | Supported (primary) |
| SQLite     | 3.x      | Supported (via Bun native) |
| MySQL      | 8.x      | Experimental (post-1.0) |

## Optional Services

| Service | Versions | Required | Purpose |
|---------|----------|----------|---------|
| Redis   | 7.x     | No       | Queue, cache, session, broadcasting, rate limiting |

## Rendering Modes

| Mode | Status |
|------|--------|
| SSR  | Supported (default for blog example) |
| SPA  | Supported |

## CI Coverage

- Every PR: Bun 1.3.x, no external DB (mocked), Redis service
- Nightly canary: Same as PR + smoke tests + audits + golden path
- Release: Full validation before publish
