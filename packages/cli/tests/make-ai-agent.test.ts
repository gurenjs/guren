import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  APP_FIXTURE,
  TSC_TIMEOUT,
  checkTypes,
  createTempWorkspace,
  linkWorkspaceCore,
  resolvedCompilerOptions,
  writeWorkspaceFiles,
  type TempWorkspace,
} from './helpers'
import { fileExists } from '../src/discovery'
import { makeAiAgent } from '../src/make-ai-agent'

const cliRoot = resolve(import.meta.dir, '..')
const repoRoot = resolve(cliRoot, '../..')

const ROUTES = `import { Router } from '@guren/core'
import { z } from 'zod'

export function registerWebRoutes(router: Router): void {
  router.get('/tickets/:id', { params: z.object({ id: z.coerce.number() }) }, () => 'ticket')
    .name('tickets_show')
    .agent({ description: 'Show a ticket.' })
  router.patch('/tickets/:id', { params: z.object({ id: z.coerce.number() }) }, () => 'ok')
    .name('tickets.update')
    .agent({ description: 'Update a ticket.' })
  router.get('/health', () => 'ok').name('health')
}
`

async function seedRoutes(): Promise<void> {
  await linkWorkspaceCore(process.cwd())
  const zodLink = join(process.cwd(), 'node_modules', 'zod')
  await mkdir(dirname(zodLink), { recursive: true })
  await symlink(join(repoRoot, 'node_modules', 'zod'), zodLink, 'dir')
  await writeWorkspaceFiles(process.cwd(), { 'routes/web.ts': ROUTES })
}

describe('guren make:ai-agent', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-make-ai-agent-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes an agent under app/Ai/Agents with a pinned wire name and no tools', async () => {
    const { files } = await makeAiAgent('support-triager')

    expect(files).toEqual([resolve('app/Ai/Agents/SupportTriager.ts')])
    const source = await readFile(resolve('app/Ai/Agents/SupportTriager.ts'), 'utf8')
    expect(source).toContain("import { Agent } from '@guren/plugin-ai'")
    expect(source).toContain('export class SupportTriager extends Agent {')
    expect(source).toContain("static override agentName = 'support-triager'")
    expect(source).not.toContain('scopes')
    expect(source).not.toContain('tools()')
  })

  it('grants and hands over the tools it checked against the routes, warning on a non-portable name', async () => {
    await seedRoutes()

    const { notes } = await makeAiAgent('Triager', { tools: 'tickets_show, tickets.update' })

    const source = await readFile(resolve('app/Ai/Agents/Triager.ts'), 'utf8')
    expect(source).toContain('export class Triager extends Agent<typeof Triager.scopes> {')
    expect(source).toContain("static override scopes = ['tool:tickets_show', 'tool:tickets.update'] as const")
    expect(source).toContain("return this.appTools(['tickets_show', 'tickets.update'])")
    expect(notes.some((note) => note.includes('"tickets.update" is outside [A-Za-z0-9_-]{1,64}'))).toBe(true)
    expect(notes.some((note) => note.includes('tickets_show'))).toBe(false)
  })

  it('refuses a tool no route derives, naming the ones that exist, before writing', async () => {
    await seedRoutes()

    await expect(makeAiAgent('Triager', { tools: 'tickets_show,health' }))
      .rejects.toThrow('No route derives the tool "health". This app exposes: tickets.update, tickets_show.')
    expect(await fileExists(process.cwd(), 'app/Ai/Agents/Triager.ts')).toBe(false)
  })

  it('refuses --tools when the routes cannot be loaded', async () => {
    await writeWorkspaceFiles(process.cwd(), { 'routes/web.ts': 'export function registerWebRoutes( {' })

    await expect(makeAiAgent('Triager', { tools: 'tickets_show' }))
      .rejects.toThrow("Could not load the app's routes to check --tools")
  })

  it('notes a missing @guren/plugin-ai and places --module agents inside the module', async () => {
    await writeFile('package.json', JSON.stringify({ name: 'app', dependencies: {} }))

    const { files, notes } = await makeAiAgent('Triager', { root: 'support', test: true })

    expect(files).toEqual([
      resolve('modules/support/app/Ai/Agents/Triager.ts'),
      resolve('modules/support/tests/Ai/Triager.test.ts'),
    ])
    expect(notes).toEqual([
      '@guren/plugin-ai is not in package.json yet. Run: bunx guren add ai',
      'The test uses TestApp.fakeAi() from @guren/testing. Run: bun add -d @guren/testing',
    ])
    const test = await readFile(resolve('modules/support/tests/Ai/Triager.test.ts'), 'utf8')
    expect(test).toContain("import app from '../../../../src/app.js'")
    expect(test).toContain("import { Triager } from '../../app/Ai/Agents/Triager.js'")
  })

  it('notes an installed @guren/testing that predates fakeAi() when writing the test', async () => {
    await writeFile('package.json', JSON.stringify({ name: 'app', devDependencies: { '@guren/testing': '^1.10.0' } }))
    await writeWorkspaceFiles(process.cwd(), {
      'node_modules/@guren/testing/dist/index.d.ts': 'export declare class TestApp {\n  agent(): unknown\n}\n',
    })

    const { notes } = await makeAiAgent('Triager', { test: true })

    expect(notes).toContain(
      'The test uses TestApp.fakeAi(), which the installed @guren/testing predates. Run: bun add -d @guren/testing@latest',
    )
  })

  it('notes nothing about @guren/testing whose declarations carry fakeAi()', async () => {
    await writeFile('package.json', JSON.stringify({ name: 'app', dependencies: { '@guren/plugin-ai': '^0.1.0' }, devDependencies: { '@guren/testing': '^1.11.0' } }))
    await writeWorkspaceFiles(process.cwd(), {
      'node_modules/@guren/testing/dist/index.d.ts': 'export declare class TestApp {\n  fakeAi(): unknown\n}\n',
    })

    expect((await makeAiAgent('Triager', { test: true })).notes).toEqual([])
  })

  it('writes into cwd rather than the process directory', async () => {
    await mkdir('elsewhere')
    await writeFile('elsewhere/vitest.config.ts', 'export default {}\n')

    const { files } = await makeAiAgent('Triager', { test: true, cwd: resolve('elsewhere') })

    expect(files).toEqual([resolve('elsewhere/app/Ai/Agents/Triager.ts'), resolve('elsewhere/tests/Ai/Triager.test.ts')])
    expect(await readFile(resolve('elsewhere/tests/Ai/Triager.test.ts'), 'utf8')).toContain("from 'vitest'")
  })

  it('writes the test for the runner the app uses', async () => {
    await writeFile('package.json', JSON.stringify({ name: 'app', devDependencies: { vitest: '^4.0.0' } }))

    await makeAiAgent('Triager', { test: true })

    expect(await readFile(resolve('tests/Ai/Triager.test.ts'), 'utf8'))
      .toContain("import { describe, expect, it } from 'vitest'")
  })

  it(
    'emits an agent with --tools and --output, and its fake-driven test, that typecheck against the plugin',
    async () => {
      await seedRoutes()
      await writeWorkspaceFiles(process.cwd(), { 'src/app.ts': APP_FIXTURE })

      const { files } = await makeAiAgent('Triager', { tools: 'tickets_show', output: true, test: true })

      const agent = await readFile(resolve('app/Ai/Agents/Triager.ts'), 'utf8')
      expect(agent).toContain('output = Output.object({ schema: TriagerOutput })')
      const test = await readFile(resolve('tests/Ai/Triager.test.ts'), 'utf8')
      expect(test).toContain("ai.respond(Triager, [{ output: { summary: 'A scripted summary.' } }])")

      const parsed = resolvedCompilerOptions(join(cliRoot, 'tsconfig.templates.json'))
      const diagnostics = checkTypes(files, {
        ...parsed,
        rootDirs: undefined,
        typeRoots: [join(repoRoot, 'node_modules'), join(cliRoot, 'node_modules/@types')],
        types: ['bun-types'],
        paths: {
          ...parsed.paths,
          '@guren/testing': [join(cliRoot, '../testing/src/index.ts')],
          zod: [join(cliRoot, 'node_modules/zod')],
        },
      })
      expect(diagnostics).toEqual([])
    },
    TSC_TIMEOUT,
  )
})
