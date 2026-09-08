import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCloudflareOutput } from './build'

import { scaffoldApp, writeAgentModule, writeAgentsConfig } from '../tests/app-fixture'

/**
 * Every shape `renderWorkerModule` can emit. A cron trigger reaching a default
 * export with no `scheduled` does nothing at all and reports nothing, so the
 * table is exhaustive over the two flags rather than one case per feature —
 * agents-and-OAuth together is the shape nobody writes a test for by hand.
 */
const SHAPES = [
  { name: 'plain', agents: false, mcpOAuth: false },
  { name: 'agents', agents: true, mcpOAuth: false },
  { name: 'mcp-oauth', agents: false, mcpOAuth: true },
  { name: 'agents and mcp-oauth', agents: true, mcpOAuth: true },
] as const

describe('the generated worker dispatches cron triggers', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-cf-scheduled-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  for (const shape of SHAPES) {
    test(`should export scheduled for the ${shape.name} worker`, async () => {
      scaffoldApp(root, { agentsPlugin: shape.agents, mcpPlugin: shape.mcpOAuth, oauthProvider: shape.mcpOAuth })
      if (shape.agents) {
        writeAgentsConfig(root, { triager: { module: 'app/Agents/Triager.ts', export: 'Triager' } })
        writeAgentModule(root, 'app/Agents/Triager.ts', 'Triager')
      }

      await buildCloudflareOutput({ rootDir: root, skipAppBuild: true, mcpOAuth: shape.mcpOAuth })

      const worker = readFileSync(join(root, '.cloudflare/worker.js'), 'utf8')
      expect(worker).toContain('const handler = createWorkersHandler(app)')

      // The provider outranks the agent entry on requests, and neither carries
      // a scheduled of its own.
      const fetchEntry = shape.mcpOAuth ? 'oauth' : shape.agents ? 'agentEntry' : 'handler'
      expect(worker).toContain(`fetch: (request, env, ctx) => ${fetchEntry}.fetch(request, env, ctx)`)

      // Exact strings, not a matcher loose enough to accept either: the two
      // shapes that gained a sweep must not be able to drag the other two along.
      expect(worker).toContain(
        shape.mcpOAuth
          ? 'scheduled: async (event, env, ctx) => {\n    await sweepOAuthStorage(oauth, event, env)\n    await handler.scheduled(event, env, ctx)\n  },'
          : 'scheduled: (event, env, ctx) => handler.scheduled(event, env, ctx),',
      )
      // The sweep is imported, not emitted — `oauth-sweep.test.ts` is what
      // exercises it. Only the wiring is this file's to pin.
      expect(worker).toContain(
        shape.mcpOAuth
          ? "import { createWorkersHandler, sweepOAuthStorage } from '@guren/plugin-cloudflare'"
          : "import { createWorkersHandler } from '@guren/plugin-cloudflare'",
      )
    })
  }

  test('should scaffold no cron trigger, naming what a scheduled app has to add', async () => {
    scaffoldApp(root)

    await buildCloudflareOutput({ rootDir: root, skipAppBuild: true })

    // A trigger every app pays for whether or not it has tasks is not scaffolded,
    // on the same rule as the OAuth KV namespace.
    const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')) as Record<string, unknown>
    expect(config.triggers).toBeUndefined()
  })
})
