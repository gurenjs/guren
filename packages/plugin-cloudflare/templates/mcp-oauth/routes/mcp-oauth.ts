/**
 * The OAuth authorize/consent routes for the App MCP endpoint, scaffolded once
 * by `guren cloudflare:build --mcp-oauth` and yours to edit from here.
 * `@cloudflare/workers-oauth-provider` answers `/oauth/token` and
 * `/oauth/register` itself; `/oauth/authorize` is the one endpoint it hands
 * back, because only the application knows who is signed in.
 *
 * **Call `registerMcpOAuthRoutes(router)` from your routes entry**, or nothing
 * mounts it. These routes are deliberately not `.agent()`-exposed: they are the
 * gate an agent passes through, not something an agent may call.
 */
import type { Router } from '@guren/core'

import McpOAuthController from '../app/Http/Controllers/McpOAuthController.js'

export function registerMcpOAuthRoutes(router: Router): void {
  router.get('/oauth/authorize', [McpOAuthController, 'show']).name('mcp-oauth.authorize')
  router.post('/oauth/authorize', [McpOAuthController, 'approve']).name('mcp-oauth.approve')
}

export default registerMcpOAuthRoutes
