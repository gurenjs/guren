# @guren/plugin-mcp

A Model Context Protocol endpoint for [Guren](https://guren.dev/) applications. Routes that declare `.agent()` become MCP tools, derived from the same contracts the routes already enforce.

```bash
bunx guren plugin @guren/plugin-mcp
```

## Setup

```typescript
// src/app.ts
import { createApp, EventServiceProvider, DatabaseApiTokenStore } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'
import { apiTokens } from '@/db/schema'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
  providers: [EventServiceProvider, mcpPlugin()],
})

// Required: the endpoint verifies bearers against this store.
app.auth.useTokens(new DatabaseApiTokenStore(apiTokens))

export default app
```

The endpoint mounts at `/mcp` and speaks streamable HTTP, stateless: one MCP server per request, with no session to keep. Bearer authentication is required, so the app must configure an [API token store](https://guren.dev/docs/guides/api-tokens).

## Configuration

```typescript
mcpPlugin({
  path: '/mcp',
  serverInfo: { name: 'blog', version: '1.0.0' },
  rateLimit: { max: 60, writeMax: 20, windowMs: 60_000 },
  updateLastUsed: true,
})
```

Writes get their own, lower limit: a tool that mutates is worth rate limiting harder than one that reads.

## API

- **`mcpPlugin(config)`** — the service provider factory. Mounts the endpoint and registers the derived tools.
- **`createAppMcpServer(options)`** — builds the MCP server for one request, for a host that wants to mount it itself.
- **`AgentRateLimiter`**, **`createRateLimitInterposition(config)`** — the rate limiter, exposed for a custom transport.
- **`@guren/plugin-mcp/oauth`** — OAuth authorization-server metadata, for clients that discover credentials rather than carrying a token.

## Checking what you expose

Before deploying, read what the routes actually advertise, and what the audit says about them:

```bash
bunx guren tool:list           # the agent tools this app exposes
bunx guren tool:inspect posts.store
bunx guren audit               # agent routes get the stricter treatment
```

`guren check` fails a read-only tool whose action mutates, and an agent route with no authorization.

## Documentation

The [agent interface guide](https://guren.dev/docs/guides/agent-interface) covers `.agent()` metadata, tool naming, and the derivation rules.

## License

MIT
