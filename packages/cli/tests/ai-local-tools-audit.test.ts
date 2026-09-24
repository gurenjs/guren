import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { deriveAgentTools, type RouteDefinition } from '@guren/core'
import { agentToolActions, auditAiLocalTools, describeLocalTool } from '../src/ai-local-tools-audit'
import type { AuditFinding } from '../src/audit'
import { parseControllerMethods } from '../src/controller-methods'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const ROUTES: RouteDefinition[] = [
  {
    method: 'PATCH',
    path: '/tickets/:id',
    name: 'tickets.update',
    agent: { toolName: 'tickets_update' },
    capabilities: {},
    controller: { name: 'TicketController', action: 'update' },
  },
]

const MODELS = {
  'app/Models/Ticket.ts': "import { defineModel } from '@guren/core'\nimport { tickets } from '@/db/schema'\nexport class Ticket extends defineModel(tickets) {}\n",
  'app/Models/Note.ts': "import { defineModel } from '@guren/core'\nimport { notes } from '@/db/schema'\nexport class Note extends defineModel(notes) {}\n",
  'app/Http/Controllers/TicketController.ts': `import { Controller } from '@guren/core'
import { Ticket } from '@/app/Models/Ticket'
export class TicketController extends Controller {
  async update() {
    await Ticket.query().where('id', 1).update({ status: 'closed' })
    return this.json({ ok: true })
  }
}
`,
}

function agent(tools: string): string {
  return `import { Agent, tool } from '@guren/plugin-ai'
import { z } from 'zod'
import { Ticket } from '@/app/Models/Ticket'
import { Note } from '@/app/Models/Note'

export class Triager extends Agent {
  static override scopes = ['tool:tickets_update'] as const
  instructions = 'Triage.'

  tools() {
${tools}
  }
}
`
}

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace('guren-ai-local-tools-')
})

afterEach(async () => {
  await workspace.cleanup()
})

async function run(files: Record<string, string>, definitions: RouteDefinition[] = ROUTES) {
  await writeWorkspaceFiles(workspace.dir, { ...MODELS, ...files })
  const findings: AuditFinding[] = []
  const scan = await parseControllerMethods(workspace.dir)
  const actions = agentToolActions(deriveAgentTools(definitions).tools, definitions)
  const listings = await auditAiLocalTools(workspace.dir, actions, scan, findings)
  return { findings, listings }
}

describe('auditAiLocalTools', () => {
  it('lists nothing and scans nothing for an app with no Agent subclass', async () => {
    const { findings, listings } = await run({})
    expect(listings).toBeUndefined()
    expect(findings).toEqual([])
  })

  it('lists every local tool beside the appTools() spread, and never an appTools() tool', async () => {
    const { findings, listings } = await run({
      'app/Ai/Agents/Triager.ts': agent(`    return {
      ...this.appTools(['tickets_update']),
      similar: tool({
        description: 'Similar tickets',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => this.make('search').similar(text),
      }),
      "weather": fetchWeather,
    }`),
    })
    expect(findings).toEqual([])
    expect(listings?.map(describeLocalTool)).toEqual([
      'Triager.similar (app/Ai/Agents/Triager.ts:13)',
      'Triager.weather (app/Ai/Agents/Triager.ts:18): execute not read',
    ])
  })

  it('advises on a local tool writing a table an .agent() route also acts on', async () => {
    const { findings, listings } = await run({
      'app/Ai/Agents/Triager.ts': agent(`    return {
      close: tool({
        inputSchema: z.object({ id: z.number() }),
        async execute({ id }) {
          const ticket = await Ticket.findOrFail(id)
          ticket.status = 'closed'
          await ticket.save()
          return { ok: true }
        },
      }),
    }`),
    })
    expect(listings?.[0]?.writes).toBe(true)
    expect(findings.map((finding) => [finding.key, finding.status])).toEqual([
      ['ai-local-tool-write:Triager.close', 'warn'],
    ])
    expect(findings[0]?.suggestion).toContain("this.appTools(['tickets_update'])")
  })

  it('stays quiet on a write to a table no agent route covers, and on a write only in a comment or string', async () => {
    const { findings, listings } = await run({
      'app/Ai/Agents/Triager.ts': agent(`    return {
      note: tool({
        execute: async ({ text }) => Note.create({ text }),
      }),
      explain: tool({
        // Ticket.create() is what the route does
        execute: async () => 'call Ticket.update() through the route',
      }),
    }`),
    })
    expect(listings?.map((listing) => [listing.tool, listing.writes])).toEqual([['note', true], ['explain', false]])
    expect(findings).toEqual([])
  })

  it('honours // guren-audit-ignore on the tool line or the line above', async () => {
    const { findings, listings } = await run({
      'app/Ai/Agents/Triager.ts': agent(`    return {
      // guren-audit-ignore -- the ticket is created before any route could see it
      open: tool({ execute: async ({ subject }) => Ticket.create({ subject }) }),
    }`),
    })
    expect(listings?.[0]?.writes).toBe(true)
    expect(findings).toEqual([])
  })

  it('lists a local tool returned from a conditional branch', async () => {
    const { findings, listings } = await run({
      'app/Ai/Agents/Triager.ts': agent(`    if (this.limited) {
      return { ...this.appTools(['tickets_update']) }
    }
    return {
      close: tool({ execute: async ({ id }) => Ticket.where('id', id).update({ status: 'closed' }) }),
    }`),
    })
    expect(findings.map((finding) => finding.key)).toEqual(['ai-local-tools-unreadable:Triager'])
    expect(findings[0]?.message).toContain('more than one place')
    expect(listings).toEqual([])
  })

  it('reads a return nested in a branch when it is the only one', async () => {
    const { findings, listings } = await run({
      'app/Ai/Agents/Triager.ts': agent(`    if (this.enabled) {
      return {
        close: tool({ execute: async ({ id }) => Ticket.where('id', id).update({ status: 'closed' }) }),
      }
    }`),
    })
    expect(listings?.map((listing) => listing.tool)).toEqual(['close'])
    expect(findings.map((finding) => finding.key)).toEqual(['ai-local-tool-write:Triager.close'])
  })

  it('warns when tools() cannot be listed whole', async () => {
    const { findings } = await run({
      'app/Ai/Agents/Triager.ts': agent('    return { ...this.appTools([\'tickets_update\']), ...shared }'),
    })
    expect(findings.map((finding) => finding.key)).toEqual(['ai-local-tools-unreadable:Triager'])
  })
})
