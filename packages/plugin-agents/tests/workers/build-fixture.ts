/**
 * Assemble the worker the workerd suite runs, with the real generator.
 *
 * RFC 0017 §7: boot-from-alarm, named exports and the `/agents/*` guard are
 * exactly the pieces a hand-written fixture cannot exercise, so the suite runs
 * `guren cloudflare:build`'s own output. Run by `bun run test:workers` before vitest.
 */
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildCloudflareOutput } from '@guren/plugin-cloudflare'

const app = fileURLToPath(new URL('./app', import.meta.url))

await buildCloudflareOutput({ rootDir: app, skipAppBuild: true })

// The generator exports exactly the classes `config/agents.ts` registers, so
// the unregistered-class case cannot come out of it — and the STRAY_AGENT
// binding in the committed wrangler.jsonc needs the export to exist at all.
// This is the hand-written export an app adds beside its generated worker.
appendFileSync(
  new URL('./app/.cloudflare/worker.js', import.meta.url),
  "\nexport { StrayAgent } from '../app/Agents/StrayAgent'\n",
)
