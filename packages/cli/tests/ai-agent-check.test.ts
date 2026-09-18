import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { RouteDefinition } from '@guren/core'
import { checkAiAgents } from '../src/ai-agent-check'
import type { CheckResult } from '../src/check-result'
import { ParseCache } from '../src/parse-cache'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

function route(overrides: Partial<RouteDefinition> & Pick<RouteDefinition, 'path'>): RouteDefinition {
  return { method: 'GET', capabilities: {}, ...overrides }
}

const ROUTES: RouteDefinition[] = [
  route({ path: '/tickets', name: 'tickets_index', agent: {} }),
  route({ path: '/tickets/:id', name: 'tickets_show', agent: {} }),
  route({ method: 'PATCH', path: '/tickets/:id', name: 'tickets_update', agent: {} }),
  route({ path: '/health', name: 'health' }),
]

const APP = `import { createApp } from '@guren/core'
import { aiPlugin } from '@guren/plugin-ai'
export default createApp({ providers: [aiPlugin()] })
`

function agentFile(body: string, header = "import { Agent, tool } from '@guren/plugin-ai'"): string {
  return `${header}
import { z } from 'zod'

export class Triager extends Agent<typeof Triager.scopes> {
${body}
  instructions = 'Triage.'
}
`
}

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-ai-agent-check-')
})

afterEach(async () => {
  await workspace.cleanup()
})

/** `null` stands for a route graph that failed to load. */
async function run(files: Record<string, string>, definitions: RouteDefinition[] | null = ROUTES): Promise<CheckResult[]> {
  await writeWorkspaceFiles(workspace.dir, files)
  return checkAiAgents({ cwd: workspace.dir, cache: new ParseCache(), definitions: definitions ?? undefined })
}

const keys = (results: CheckResult[]) => results.map((result) => result.key).sort()
const byKey = (results: CheckResult[], key: string) => results.find((result) => result.key === key)

describe('checkAiAgents', () => {
  it('contributes nothing to an app with no Agent subclass', async () => {
    expect(await run({ 'src/app.ts': APP, 'app/Services/Search.ts': 'export class Search {}\n' })).toEqual([])
  })

  it('does not take a durable Agent from another package for an in-process one', async () => {
    const durable = `import { Agent } from '@guren/plugin-agents'
export class Support extends Agent { tools() { return this.appTools(['nope']) } }
`
    expect(await run({ 'app/Agents/Support.ts': durable })).toEqual([])

    const mixed = `import { tool } from '@guren/plugin-ai'
import { Agent } from '@guren/plugin-agents'
export class Support extends Agent { tools() { return { t: tool({}) } } }
`
    expect(await run({ 'app/Agents/Support.ts': mixed })).toEqual([])
  })

  it('passes a wired agent, through as const and an aliased import', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        `  static override scopes = ['tool:tickets_index', 'tools:read', 'tool:tickets_update'] as const
  tools() {
    return { ...this.appTools(['tickets_index', 'tickets_show', 'tickets_update'] as const) }
  }`,
        "import { Agent as Base } from '@guren/plugin-ai'",
      ).replace('extends Agent<', 'extends Base<'),
    })
    expect(results.map((result) => [result.key, result.status])).toEqual([['ai-agents', 'pass']])
  })

  it('fails a name no .agent() route derives', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static override scopes = ['tools:*'] as const\n  tools() { return this.appTools(['tickets_index', 'health']) }",
      ),
    })
    expect(keys(results)).toEqual(['ai-agent-tool-underived:Triager:health'])
    expect(byKey(results, 'ai-agent-tool-underived:Triager:health')?.status).toBe('fail')
  })

  it('fails a name the class scopes do not grant, judging tools:read by the derived annotation', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static override scopes = ['tools:read']\n  tools() { return this.appTools(['tickets_show', 'tickets_update']) }",
      ),
    })
    expect(keys(results)).toEqual(['ai-agent-tool-unscoped:Triager:tickets_update'])
    expect(results[0]?.status).toBe('fail')
  })

  it('treats an agent with no static scopes as granting nothing', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile("  tools() { return this.appTools(['tickets_show']) }"),
    })
    expect(keys(results)).toEqual(['ai-agent-tool-unscoped:Triager:tickets_show'])
  })

  it('fails a scope entry outside the grammar', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static override scopes = ['tickets_show', 'tool:tickets_index']\n  tools() { return this.appTools(['tickets_index']) }",
      ),
    })
    expect(keys(results)).toEqual(['ai-agent-scope-malformed:Triager:tickets_show'])
    expect(results[0]?.suggestion).toContain("'tool:tickets_show'")
  })

  it('reports a spread or computed appTools() argument as unverifiable, never passed', async () => {
    const spread = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static override scopes = ['tools:*']\n  tools() { return this.appTools([...NAMES]) }",
      ),
    })
    expect(keys(spread)).toEqual(['ai-agent-app-tools-unreadable:Triager:6'])
    expect(spread[0]?.status).toBe('warn')
    expect(spread[0]?.message).toContain('spread')

    const computed = await run({
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static override scopes = ['tools:*']\n  tools() { return this.appTools(names) }",
      ),
    })
    expect(byKey(computed, 'ai-agent-app-tools-unreadable:Triager:6')?.message).toContain('not an array literal')
    expect(computed.some((result) => result.status === 'pass')).toBe(false)
  })

  it('warns on unreadable scopes instead of judging names against a guess', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static override scopes = SCOPES\n  tools() { return this.appTools(['tickets_update']) }",
      ),
    })
    expect(keys(results)).toEqual(['ai-agent-scopes-unreadable:Triager'])
  })

  it('warns that names are unverified when the route graph did not load', async () => {
    const results = await run(
      {
        'src/app.ts': APP,
        'app/Ai/Agents/Triager.ts': agentFile("  static override scopes = ['tools:*']\n  tools() { return this.appTools(['anything']) }"),
      },
      null,
    )
    expect(keys(results)).toEqual(['ai-agent-tools-unverified:Triager'])
  })

  it('follows a subclass of an agent across files, inheriting scopes and tools()', async () => {
    const base = agentFile(
      "  static override scopes = ['tool:tickets_index']\n  tools() { return this.appTools(['tickets_index', 'tickets_show']) }",
    ).replace('Agent<typeof Triager.scopes>', 'Agent')
    const child = `import { Triager } from './Triager'
export class Escalator extends Triager {}
`
    const results = await run({ 'src/app.ts': APP, 'app/Ai/Agents/Triager.ts': base, 'app/Ai/Agents/Escalator.ts': child })
    expect(keys(results)).toEqual([
      'ai-agent-tool-unscoped:Escalator:tickets_show',
      'ai-agent-tool-unscoped:Triager:tickets_show',
    ])
  })

  it('warns that an agent using appTools() will throw in an app that never calls aiPlugin()', async () => {
    const results = await run({
      'src/app.ts': "import { createApp } from '@guren/core'\nexport default createApp({ providers: [] })\n",
      'app/Ai/Agents/Triager.ts': agentFile("  static override scopes = ['tools:*']\n  tools() { return this.appTools(['tickets_index']) }"),
    })
    expect(keys(results)).toEqual(['ai-agent-plugin-missing'])
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.message).toContain('Triager calls appTools()')
  })

  it('finds aiPlugin() wherever the provider list is assembled', async () => {
    const results = await run({
      'bootstrap/providers.ts': "import { aiPlugin } from '@guren/plugin-ai'\nexport const providers = [aiPlugin()]\n",
      'app/Ai/Agents/Triager.ts': agentFile(''),
    })
    expect(keys(results)).toEqual(['ai-agents'])
  })

  it('does not count a same-named function from another package as aiPlugin()', async () => {
    const results = await run({
      'src/app.ts': "import { aiPlugin } from './fake'\nexport default createApp({ providers: [aiPlugin()] })\n",
      'app/Ai/Agents/Triager.ts': agentFile(''),
    })
    expect(keys(results)).toEqual(['ai-agent-plugin-missing'])
  })

  it('reads a namespace import of the plugin as the plugin', async () => {
    const results = await run({
      'src/app.ts': "import * as ai from '@guren/plugin-ai'\nexport default createApp({ providers: [ai.aiPlugin()] })\n",
      'app/Ai/Agents/Triager.ts': agentFile(''),
    })
    expect(keys(results)).toEqual(['ai-agents'])
  })

  it('checks both agents when two files declare one under the same name', async () => {
    const body = "  static override scopes = []\n  tools() { return this.appTools(['tickets_show']) }"
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(body),
      'modules/billing/app/Ai/Agents/Triager.ts': agentFile(body),
    })
    expect(keys(results)).toEqual([
      'ai-agent-tool-unscoped:Triager:tickets_show',
      'ai-agent-tool-unscoped:Triager:tickets_show',
    ])
  })

  it('reads static scopes under a quoted key, and refuses to judge a getter', async () => {
    const quoted = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static 'scopes' = ['tools:*'] as const\n  tools() { return this.appTools(['tickets_show']) }",
      ),
    })
    expect(keys(quoted)).toEqual(['ai-agents'])

    const getter = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': agentFile(
        "  static get scopes() { return ['tools:*'] as const }\n  tools() { return this.appTools(['tickets_show']) }",
      ),
    })
    expect(keys(getter)).toEqual(['ai-agent-scopes-unreadable:Triager'])
  })

  it('resolves a superclass through its import, not its spelling', async () => {
    const base = `import { Agent } from '@guren/plugin-ai'
export class Base extends Agent {
  static override scopes = []
  tools() { return this.appTools(['tickets_show']) }
}
`
    // A same-named class from another package is not this agent's subclass.
    const unrelated = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Base.ts': base,
      'app/Services/Thing.ts': "import { Base } from 'some-library'\nexport class Child extends Base { tools() { return this.appTools(['nope']) } }\n",
    })
    expect(keys(unrelated)).toEqual(['ai-agent-tool-unscoped:Base:tickets_show'])

    // An aliased import of the agent itself is one.
    const aliased = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Base.ts': base,
      'app/Ai/Agents/Child.ts': "import { Base as Parent } from './Base'\nexport class Child extends Parent {}\n",
    })
    expect(keys(aliased)).toEqual([
      'ai-agent-tool-unscoped:Base:tickets_show',
      'ai-agent-tool-unscoped:Child:tickets_show',
    ])
  })

  it('judges an inherited tools() the override still calls against the subclass scopes', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Base.ts': `import { Agent } from '@guren/plugin-ai'
export class Base extends Agent {
  static override scopes = ['tools:*'] as const
  tools() { return this.appTools(['tickets_show']) }
}
`,
      'app/Ai/Agents/Child.ts': `import { Base } from './Base'
export class Child extends Base {
  static override scopes = []
  override tools() { return { ...super.tools() } }
}
`,
    })
    expect(keys(results)).toEqual(['ai-agent-tool-unscoped:Child:tickets_show'])
  })

  it('reads an agent and its calls through a namespace import', async () => {
    const results = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': `import * as ai from '@guren/plugin-ai'
export class Triager extends ai.Agent {
  static scopes = ['tools:*'] as const
  tools() { return this['appTools'](['nope']) }
}
`,
    })
    expect(keys(results)).toEqual(['ai-agent-tool-underived:Triager:nope'])
  })

  it('does not judge a call whose receiver is another agent or another object', async () => {
    const helper = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Triager.ts': `import { Agent, appTools } from '@guren/plugin-ai'
export class Triager extends Agent {
  static scopes = []
  tools() { return appTools(otherAgent, ['tickets_show']) }
}
`,
    })
    expect(keys(helper)).toEqual(['ai-agents'])

    const nested = await run({
      'src/app.ts': APP,
      'app/Ai/Agents/Other.ts': `import { Agent } from '@guren/plugin-ai'
export class Other extends Agent {
  static scopes = []
  tools() {
    const helper = { appTools(names) { return {} }, build() { return this.appTools(['nope']) } }
    return helper.build()
  }
}
`,
    })
    expect(keys(nested)).toEqual(['ai-agents'])
  })

  it('does not accuse the app of two audit trails over a call outside it', async () => {
    // Each half outside the app in turn: one widened scan is enough to accuse it falsely.
    const appAudit = `import { aiPlugin } from '@guren/plugin-ai'
import { mcpPlugin } from '@guren/plugin-mcp'
export default createApp({ providers: [aiPlugin(), mcpPlugin({ audit: { file: 'a' } })] })
`
    const withAiHelper = await run({
      'src/app.ts': appAudit,
      'tests/support/app.ts': "import { aiPlugin } from '@guren/plugin-ai'\nexport const testProviders = [aiPlugin({ audit: { file: 'b' } })]\n",
      'app/Ai/Agents/Triager.ts': agentFile(''),
    })
    expect(keys(withAiHelper)).toEqual(['ai-agents'])

    const withMcpHelper = await run({
      'src/app.ts': "import { aiPlugin } from '@guren/plugin-ai'\nexport default createApp({ providers: [aiPlugin({ audit: { file: 'a' } })] })\n",
      'tests/support/app.ts': "import { mcpPlugin } from '@guren/plugin-mcp'\nexport const testProviders = [mcpPlugin({ audit: { file: 'b' } })]\n",
      'app/Ai/Agents/Triager.ts': agentFile(''),
    })
    expect(keys(withMcpHelper)).toEqual(['ai-agents'])
  })

  it('does not read an audit key the runtime never configures', async () => {
    const providers = `import { aiPlugin } from '@guren/plugin-ai'
import { mcpPlugin } from '@guren/plugin-mcp'
export const providers = [
  aiPlugin({ audit: undefined }),
  mcpPlugin({ audit: { file: 'storage/mcp.jsonl' } }),
]
`
    expect(keys(await run({ 'config/providers.ts': providers, 'app/Ai/Agents/Triager.ts': agentFile('') }))).toEqual(['ai-agents'])

    const conditional = providers.replace('audit: undefined', "audit: flag ? { file: 'a' } : undefined")
    expect(keys(await run({ 'config/providers.ts': conditional, 'app/Ai/Agents/Triager.ts': agentFile('') }))).toEqual(['ai-agents'])
  })

  it('fails an audit trail configured in both aiPlugin() and mcpPlugin()', async () => {
    const providers = `import { aiPlugin } from '@guren/plugin-ai'
import { mcpPlugin } from '@guren/plugin-mcp'
export const providers = [
  aiPlugin({ audit: { file: 'storage/ai.jsonl' } } satisfies object),
  mcpPlugin({ audit: { file: 'storage/mcp.jsonl' }, approvals: { store, notify } }),
]
`
    const results = await run({ 'config/providers.ts': providers, 'app/Ai/Agents/Triager.ts': agentFile('') })
    expect(keys(results)).toEqual(['ai-agent-audit-duplicate'])
    expect(results[0]?.status).toBe('fail')
    expect(results[0]?.message).toContain('config/providers.ts')
  })

  it('does not report two approval queues, which the plugins never share', async () => {
    const providers = `import { aiPlugin } from '@guren/plugin-ai'
import { mcpPlugin } from '@guren/plugin-mcp'
export const providers = [aiPlugin({ approvals: a }), mcpPlugin({ audit: { file: 'x' }, approvals: b })]
`
    const results = await run({ 'config/providers.ts': providers, 'app/Ai/Agents/Triager.ts': agentFile('') })
    expect(keys(results)).toEqual(['ai-agents'])
  })
})
