import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { Controller, Router, deriveAgentTools } from '@guren/core'
import { assertWorkspaceBuilt, checkTypes, GENERATED_MODULE_COMPILER_OPTIONS, TSC_TIMEOUT } from './helpers'
import { buildAgentToolsContent } from '../src/agents-types'

/**
 * Compile-time gate for the `@guren/plugin-ai` half of `.guren/agents.gen.ts`
 * (RFC 0029 §11): only a real program against the plugin's built declarations
 * proves the augmentation narrows `appTools()`. The plugin is reached by path,
 * never imported, so `@guren/cli` gains no dependency on it (needs `bun run build`).
 */

const repoRoot = resolve(import.meta.dir, '../../..')
const pluginAiTypes = join(repoRoot, 'packages/plugin-ai/dist/index.d.ts')
// The probe reads the AI SDK's tool inference as the plugin sees it: its own copy.
const aiTypes = join(repoRoot, 'packages/plugin-ai/node_modules/ai/dist/index.d.ts')

class PostController extends Controller {
  async index() {
    return this.json({ total: 0 })
  }
}

function definitions() {
  const router = new Router()
  router
    .get(
      '/posts',
      {
        name: 'posts.index',
        query: z.object({ page: z.coerce.number().optional(), since: z.coerce.date().optional() }),
        output: z.object({ total: z.number() }),
      },
      [PostController, 'index'],
    )
    .agent({})
  router
    .put(
      '/posts/:id',
      {
        name: 'posts.update',
        params: z.object({ id: z.coerce.number() }),
        body: z.object({ title: z.string().min(1), draft: z.boolean().optional() }),
      },
      [PostController, 'index'],
    )
    .agent({})
  router
    .post('/posts/bulk', { name: 'posts.bulk', body: z.array(z.string()) }, [PostController, 'index'])
    .agent({})
  router.get('/files/:name', { name: 'files.show' }, [PostController, 'index']).agent({})
  return router.definitions()
}

const PROBE = `import {
  Agent,
  type AgentToolInput,
  type AgentToolName,
  type AgentToolOutput,
  type AiManager,
  type AppToolDenial,
  type AppToolError,
} from '@guren/plugin-ai'
import type { InferToolInput, InferToolOutput } from 'ai'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
function expectType<T extends true>(_: T): void {}

export class Triager extends Agent<typeof Triager.scopes> {
  static override scopes = ['tool:posts.index', 'tool:posts.update'] as const
  instructions = 'Triage posts.'

  override tools() {
    // @ts-expect-error -- derived, but not granted by static scopes
    this.appTools(['posts.index', 'files.show'])
    const tools = this.appTools(['posts.index', 'posts.update'])
    expectType<Equal<InferToolInput<typeof tools['posts.index']>, { page?: number; since?: string }>>(true)
    expectType<Equal<InferToolOutput<typeof tools['posts.index']>, { total: number } | AppToolDenial | AppToolError>>(true)
    return tools
  }
}

declare const ai: AiManager
ai.agent(Triager).as(null)
Triager.as(null)
void Triager.prompt('Triage.')

export class Unparameterized extends Agent {
  static override scopes = ['tool:posts.index'] as const
  instructions = 'Without the scopes parameter only the names are checked.'

  override tools() {
    // @ts-expect-error -- no route derives this tool
    this.appTools(['posts.indx'])
    return this.appTools(['posts.index'])
  }
}

export class PrefixGranted extends Agent<typeof PrefixGranted.scopes> {
  static override scopes = ['tools:posts.*'] as const
  instructions = 'A prefix grant is settled at construction, not by the compiler.'

  override tools() {
    // @ts-expect-error -- a typo is still a compile error under a prefix grant
    this.appTools(['posts.bulkk'])
    return this.appTools(['posts.bulk', 'files.show'])
  }
}

expectType<Equal<AgentToolName, 'files.show' | 'posts.bulk' | 'posts.index' | 'posts.update'>>(true)
expectType<Equal<AgentToolInput<'posts.update'>, { id: number; title: string; draft?: boolean }>>(true)
expectType<Equal<AgentToolInput<'posts.bulk'>, { body: string[] }>>(true)
expectType<Equal<AgentToolInput<'files.show'>, { name: string }>>(true)
expectType<Equal<AgentToolOutput<'posts.index'>, { total: number }>>(true)
`

const compilerOptions = {
  ...GENERATED_MODULE_COMPILER_OPTIONS,
  paths: { '@guren/plugin-ai': [pluginAiTypes], ai: [aiTypes] },
}

let dir: string
let generatedFile: string
let probeFile: string

beforeAll(async () => {
  assertWorkspaceBuilt([pluginAiTypes, aiTypes])

  dir = await mkdtemp(join(tmpdir(), 'guren-agents-plugin-ai-compile-'))
  generatedFile = join(dir, 'agents.gen.ts')
  probeFile = join(dir, 'probe.ts')

  const defs = definitions()
  const { tools } = deriveAgentTools(defs)
  await writeFile(generatedFile, buildAgentToolsContent(tools, { pluginAi: { definitions: defs } }))
  await writeFile(probeFile, PROBE)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('generated @guren/plugin-ai augmentation', () => {
  test('types appTools(): known granted names pass, a typo or an ungranted name is rejected', () => {
    // Zero diagnostics proves both polarities: an accepted bad name would
    // surface as TS2578, "unused @ts-expect-error".
    expect(checkTypes([generatedFile, probeFile], compilerOptions)).toEqual([])
  }, TSC_TIMEOUT)

  test('without the generated file the same probe fails (the gate can catch a broken augmentation)', () => {
    const diagnostics = checkTypes([probeFile], compilerOptions)

    // Both typo probes go unused; the ungranted probe does not, since a grant
    // is checked against the scopes tuple whether or not codegen ran.
    expect(diagnostics.filter((d) => d.includes('TS2578'))).toHaveLength(2)
    // Every expectType probe reads a generated type: the name union, three inputs,
    // one output and the two appTools() result types.
    expect(diagnostics.filter((d) => d.includes('TS2344'))).toHaveLength(7)
  }, TSC_TIMEOUT)
})
