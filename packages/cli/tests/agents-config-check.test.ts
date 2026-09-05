import { describe, it, expect } from 'bun:test'
import { z } from 'zod'
import type { RouteDefinition } from '@guren/core'

import { checkAgentsConfig } from '../src/agents-config-check'
import { makeAgent } from '../src/make-agent'
import { ParseCache } from '../src/parse-cache'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

/**
 * The registry check (RFC 0017 §3).
 *
 * Every case covers one of two failures nothing else in the toolchain sees: a
 * registry the Cloudflare build cannot read statically, and a scope an
 * unattended principal may not hold.
 */

const AGENT_MODULE = `import { GurenAgent } from '@guren/plugin-agents/agent'

export class Triager extends GurenAgent<Env, { n: number }> {
  initialState = { n: 0 }
}
`

function definitions(): RouteDefinition[] {
  return [
    {
      method: 'GET',
      path: '/posts',
      name: 'posts.index',
      capabilities: {},
      agent: { description: 'List posts' },
      schemas: { output: z.object({ ok: z.boolean() }) },
    },
    {
      method: 'POST',
      path: '/posts',
      name: 'posts.store',
      capabilities: {},
      agent: { description: 'Create a post' },
      schemas: { output: z.object({ ok: z.boolean() }) },
    },
  ]
}

async function inWorkspace<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const workspace = await createTempWorkspace('guren-agents-config-')
  try {
    return await run(workspace.dir)
  } finally {
    await workspace.cleanup()
  }
}

/** Run the check over a registry whose only agent carries `scopes`. */
async function runCheckOn(
  dir: string,
  scopes: string,
  withDefinitions = true,
): Promise<Awaited<ReturnType<typeof checkAgentsConfig>>> {
  await writeWorkspaceFiles(dir, {
    'config/agents.ts': registry(scopes),
    'app/Agents/Triager.ts': AGENT_MODULE,
  })
  return checkAgentsConfig({
    cwd: dir,
    cache: new ParseCache(),
    ...(withDefinitions ? { definitions: definitions() } : {}),
  })
}

const statuses = (result: Awaited<ReturnType<typeof checkAgentsConfig>>): string[] =>
  result.checks.map((entry) => entry.status)

function registry(scopes: string, extra = ''): string {
  return `import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ${scopes},
    },${extra}
  },
})
`
}

describe('checkAgentsConfig', () => {
  it('contributes nothing to an app with no registry', async () => {
    await inWorkspace(async (dir) => {
      expect(await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })).toEqual({ checks: [] })
    })
  })

  it('passes on the output of make:agent', async () => {
    await inWorkspace(async (dir) => {
      // The scaffolder's own output is the fixture: a check that disagreed
      // with `make:agent` would fail every app the moment it ran the command.
      await makeAgent('Triager', { cwd: dir })
      const result = await checkAgentsConfig({
        cwd: dir,
        cache: new ParseCache(),
        definitions: definitions(),
      })

      expect(statuses(result)).toEqual(['pass'])
    })
  })

  it('reports what tools:read expands to, per agent', async () => {
    await inWorkspace(async (dir) => {
      const result = await runCheckOn(dir, "['tools:read']")

      // Open Question 2, kept a check-time computation: the read-only tool,
      // never the write one.
      expect(result.expansions).toEqual([{ agent: 'triager', tools: ['posts.index'] }])
    })
  })

  it('reports an empty expansion when the route graph was not loaded', async () => {
    await inWorkspace(async (dir) => {
      // Empty, not absent: the app *does* host agents. Absent is reserved for
      // an app with no registry at all, so a JSON consumer can tell "no
      // agents" from "agents whose scopes expand to nothing here".
      const result = await runCheckOn(dir, "['tools:read']", false)
      expect(result.expansions).toEqual([])
    })
  })

  for (const scope of ['tools:*', 'tools:posts.*', 'posts.index']) {
    it(`fails a registration scoped to ${scope}`, async () => {
      await inWorkspace(async (dir) => {
        const result = await runCheckOn(dir, `['${scope}']`)
        const finding = result.checks.find((entry) => entry.key.startsWith('agents-config-scope:'))

        expect(finding?.status).toBe('fail')
        expect(finding?.key).toBe(`agents-config-scope:triager:${scope}`)
      })
    })
  }

  it('warns about a tool no route declares, without failing', async () => {
    await inWorkspace(async (dir) => {
      const result = await runCheckOn(dir, "['tool:posts.destroy']")
      const finding = result.checks.find((entry) => entry.key.includes('unknown-tool'))

      // A warning, not a failure: the scope gate is fail-closed, so the
      // consequence is an agent that can call less than it looks like it can.
      expect(finding?.status).toBe('warn')
      expect(finding?.message).toContain('grants nothing')
      expect(statuses(result)).not.toContain('fail')
    })
  })

  it('reads scopes written as const', async () => {
    // `as const` changes nothing the Cloudflare build cares about, and a shape
    // test that skipped the unwrap reported a fully static registry as one
    // whose scopes could not be read.
    await inWorkspace(async (dir) => {
      const result = await runCheckOn(dir, "['tools:read'] as const")

      expect(statuses(result)).toEqual(['pass'])
      expect(result.expansions).toEqual([{ agent: 'triager', tools: ['posts.index'] }])
    })
  })

  it('reads a default export wrapped in satisfies', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'config/agents.ts': `import { defineAgentsConfig, type AgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ['tools:read'],
    },
  },
}) satisfies AgentsConfig
`,
      })

      const result = await checkAgentsConfig({
        cwd: dir,
        cache: new ParseCache(),
        definitions: definitions(),
      })

      expect(statuses(result)).toEqual(['pass'])
    })
  })

  it('fails two registrations claiming the same exported class', async () => {
    // One class is one agent. Both the runtime registry and the generated
    // worker's named exports are keyed on the export name, so the second claim
    // makes one of the two unreachable — silently, on whichever agent loses.
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    first: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: [] },
    second: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: [] },
  },
})
`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      const finding = result.checks.find((entry) => entry.key.includes('duplicate-export'))

      expect(finding?.status).toBe('fail')
      // Reported against the *second* claim, which is the one to delete.
      expect(finding?.key).toBe('agents-config-duplicate-export:second')
      expect(finding?.message).toContain('already registered as "first"')
    })
  })

  it('does not report a duplicate for two agents on different classes', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'app/Agents/Reporter.ts': AGENT_MODULE.replace(/Triager/gu, 'Reporter'),
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: [] },
    reporter: { module: 'app/Agents/Reporter.ts', export: 'Reporter', scopes: [] },
  },
})
`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(statuses(result)).toEqual(['pass'])
    })
  })

  it('fails a spread in the agents object, beside an otherwise valid entry', async () => {
    await inWorkspace(async (dir) => {
      // Everything about `triager` is readable; what the build cannot follow is
      // the spread, so whatever it contributes deploys as nothing.
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'config/extra.ts': 'export const extra = {}\n',
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'
import { extra } from './extra'

export default defineAgentsConfig({
  agents: {
    ...extra,
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ['tools:read'],
    },
  },
})
`,
      })

      const spread = await checkAgentsConfig({
        cwd: dir,
        cache: new ParseCache(),
        definitions: definitions(),
      })
      const finding = spread.checks.find((entry) => entry.key === 'agents-config-spread')

      expect(finding?.status).toBe('fail')
      expect(finding?.message).toContain('cannot follow one')
    })
  })

  it('fails a registry the build cannot read at all', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'
import { registry } from './registry'

export default defineAgentsConfig({ agents: registry })
`,
      })

      const result = await checkAgentsConfig({
        cwd: dir,
        cache: new ParseCache(),
        definitions: definitions(),
      })

      expect(result.checks).toHaveLength(1)
      expect(result.checks[0]!.key).toBe('agents-config-grammar')
      expect(result.checks[0]!.status).toBe('fail')
    })
  })

  it('fails a non-literal module path', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'

const dir = 'app/Agents'

export default defineAgentsConfig({
  agents: {
    triager: { module: \`\${dir}/Triager.ts\`, export: 'Triager', scopes: [] },
  },
})
`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(result.checks[0]!.key).toBe('agents-config-static:triager')
      expect(result.checks[0]!.message).toContain('not a literal string')
    })
  })

  it('fails a module that does not exist', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'config/agents.ts': registry("['tools:read']"),
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(result.checks[0]!.key).toBe('agents-config-module:triager')
      expect(result.checks[0]!.status).toBe('fail')
    })
  })

  it('fails a module that exists but does not export the class', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'config/agents.ts': registry("['tools:read']"),
        'app/Agents/Triager.ts': `import { GurenAgent } from '@guren/plugin-agents/agent'

export class Sweeper extends GurenAgent<Env, unknown> {}
`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(result.checks[0]!.key).toBe('agents-config-export:triager')
      expect(result.checks[0]!.message).toContain('does not export "Triager"')
    })
  })

  for (const [label, module] of [
    ['a renamed export', "export class Actual extends GurenAgent<Env, unknown> {}\nexport { Actual as Triager }\n"],
    ['a type-only export', "class Triager {}\nexport type { Triager }\n"],
    ['a non-class value', "export const Triager = 42\n"],
  ] as Array<[string, string]>) {
    it(`fails ${label} the runtime could not resolve`, async () => {
      // An agent is found by `this.constructor.name`. A renamed export binds a
      // class named `Actual`, a type-only export binds nothing at runtime, and
      // a number has no constructor name to match — each registers under a name
      // the Durable Object will never report about itself.
      await inWorkspace(async (dir) => {
        await writeWorkspaceFiles(dir, {
          'config/agents.ts': registry("['tools:read']"),
          'app/Agents/Triager.ts': `import { GurenAgent } from '@guren/plugin-agents/agent'\n\n${module}`,
        })

        const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
        const finding = result.checks.find((entry) => entry.key.startsWith('agents-config-export:'))

        expect(finding?.status).toBe('fail')
        expect(finding?.message).toContain('constructor.name')
      })
    })
  }

  it('accepts a class declaration exported directly', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'config/agents.ts': registry("['tools:read']"),
        'app/Agents/Triager.ts': AGENT_MODULE,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(result.checks.find((entry) => entry.key.startsWith('agents-config-export:'))).toBeUndefined()
    })
  })

  it('accepts a class exported by its own name through a specifier', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'config/agents.ts': registry("['tools:read']"),
        'app/Agents/Triager.ts': `import { GurenAgent } from '@guren/plugin-agents/agent'\n\n`
          + `class Triager extends GurenAgent<Env, unknown> {}\nexport { Triager }\n`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(result.checks.find((entry) => entry.key.startsWith('agents-config-export:'))).toBeUndefined()
    })
  })

  it('fails the same agent key declared twice', async () => {
    // The later entry wins and the earlier is discarded, so a registration a
    // human can still read does nothing.
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: [] },
    triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: ['tools:read'] },
  },
})
`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      const finding = result.checks.find((entry) => entry.key.includes('duplicate-agent'))

      expect(finding?.status).toBe('fail')
      expect(finding?.message).toContain('silently discarded')
    })
  })

  it('fails a registration with no literal scopes array', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'app/Agents/Triager.ts': AGENT_MODULE,
        'config/agents.ts': `import { defineAgentsConfig } from '@guren/plugin-agents'

const shared = ['tools:read']

export default defineAgentsConfig({
  agents: {
    triager: { module: 'app/Agents/Triager.ts', export: 'Triager', scopes: shared },
  },
})
`,
      })

      const result = await checkAgentsConfig({ cwd: dir, cache: new ParseCache() })
      expect(result.checks[0]!.key).toBe('agents-config-scopes:triager')
      expect(result.checks[0]!.status).toBe('fail')
    })
  })
})
