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
