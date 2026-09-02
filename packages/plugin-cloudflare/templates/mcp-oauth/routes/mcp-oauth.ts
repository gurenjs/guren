/**
 * The OAuth authorize/consent routes for the App MCP endpoint, scaffolded once
 * by `guren cloudflare:build --mcp-oauth` and yours to edit from here.
 *
 * `@cloudflare/workers-oauth-provider` owns `/oauth/token` and
 * `/oauth/register` itself — it answers them before the request ever reaches
 * this application. `/oauth/authorize` is the one endpoint the provider hands
 * back, because only the application can say who is signed in and render a
 * consent screen that means anything.
 *
 * **Wire this into your routes entry**, or nothing mounts it:
 *
 * ```ts
 * // routes/web.ts
 * import { registerMcpOAuthRoutes } from './mcp-oauth'
 *
 * export function registerWebRoutes(router: Router): void {
 *   registerMcpOAuthRoutes(router)
 *   // …your own routes
 * }
 * ```
 *
 * These routes are deliberately **not** `.agent()`-exposed: they are the gate
 * an agent passes through, not something an agent may call.
 */
import type { Router } from '@guren/core'

import McpOAuthController from '../app/Http/Controllers/McpOAuthController.js'

export function registerMcpOAuthRoutes(router: Router): void {
  router.get('/oauth/authorize', [McpOAuthController, 'show']).name('mcp-oauth.authorize')
  router.post('/oauth/authorize', [McpOAuthController, 'approve']).name('mcp-oauth.approve')
}

export default registerMcpOAuthRoutes
