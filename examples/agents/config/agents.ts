import { defineAgentsConfig } from '@guren/plugin-agents'

/**
 * `module` and `export` are literal strings: `guren cloudflare:build` reads
 * this file as source for the worker's named exports, and `guren check` fails
 * a spread, a computed key, or any non-literal value.
 * Scopes are `tool:<name>` or `tools:read`; set grants (`tools:*`, prefixes)
 * are refused, so an unattended agent cannot consent to tools not yet written.
 */
export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      // Exact names, not `tools:read`: the triager reads tickets and closes
      // them, and a read grant would silently widen with every new read-only
      // route. `tickets.close` is gated on a human approval by the route.
      scopes: ['tool:tickets.index', 'tool:tickets.close'],
      // Per in-memory instance, so an eviction resets it: a burst floor, not a
      // quota. A sweep spends the index call plus one per fresh ask, and
      // `MAX_ASKS_PER_SWEEP` caps that at 10 — 11 in all, so a backlog cannot
      // spend the window and starve the tickets behind it.
      budget: { callsPerMinute: 30 },
    },
  },
})
