import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { consola } from 'consola'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  APP_FIXTURE,
  ENV_SCHEMA_FIXTURE,
  createTempWorkspace,
  linkWorkspaceCore,
  linkWorkspacePackage,
  writeWorkspaceFiles,
  type TempWorkspace,
} from './helpers'
import { addAi, aiPackageRange } from '../src/add-ai'
import { checkEnvExample } from '../src/app-env'
import { fileExists } from '../src/discovery'
import { loadResolvedConfig } from '../src/resolved-config'

const cliRoot = resolve(import.meta.dir, '..')

async function seedApp(options: { env?: boolean; manifest?: Record<string, unknown> } = {}): Promise<void> {
  await writeWorkspaceFiles(process.cwd(), {
    'src/app.ts': APP_FIXTURE,
    '.env.example': 'APP_KEY=\n',
    '.env': 'APP_KEY=\n',
    'package.json': JSON.stringify(options.manifest ?? { name: 'app', dependencies: {} }),
    ...(options.env === false ? {} : { 'config/env.ts': ENV_SCHEMA_FIXTURE }),
  })
}

/** What `consola.info` printed while `task` ran. */
async function infoLines(task: () => Promise<unknown>): Promise<string[]> {
  const spy = spyOn(consola, 'info').mockImplementation((() => {}) as never)
  try {
    await task()
    return spy.mock.calls.map((args) => args.map(String).join(' '))
  } finally {
    spy.mockRestore()
  }
}

describe('guren add ai', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-add-ai-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('writes config/ai.ts, wires it and aiPlugin() into createApp, and declares the key', async () => {
    await seedApp()

    const created = await addAi({})

    expect(created.some((file) => file.endsWith('config/ai.ts'))).toBe(true)
    const config = await readFile(resolve('config/ai.ts'), 'utf8')
    expect(config).toContain("import { createAnthropic } from '@ai-sdk/anthropic'")
    expect(config).toContain('createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })')

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app).toContain("import ai from '../config/ai.js'")
    expect(app).toMatch(/config: \[ai\]/)
    expect(app).toContain("import { aiPlugin } from '@guren/plugin-ai'")
    expect(app).toMatch(/providers: \[aiPlugin\(\)\]/)

    for (const file of ['.env.example', '.env']) {
      expect(await readFile(resolve(file), 'utf8')).toContain('\nANTHROPIC_API_KEY=\n')
    }
    // Optional, so `bun run dev` boots before the user has a key.
    expect(await readFile(resolve('config/env.ts'), 'utf8'))
      .toContain('ANTHROPIC_API_KEY: Env.string().optional().secret(),')
  })

  it('prints the packages to add with the ranges the templates were checked against', async () => {
    await seedApp()

    const lines = await infoLines(() => addAi({ provider: 'openai' }))

    expect(lines).toContain(
      `Run: bun add @guren/plugin-ai ai@${aiPackageRange('ai')} @ai-sdk/openai@${aiPackageRange('@ai-sdk/openai')}`,
    )
    expect(await readFile(resolve('config/ai.ts'), 'utf8')).toContain("import { createOpenAI } from '@ai-sdk/openai'")
    expect(await readFile(resolve('config/env.ts'), 'utf8')).toContain('OPENAI_API_KEY: Env.string().optional().secret(),')
  })

  it('installs no provider package for the gateway and skips packages the app already has', async () => {
    await seedApp({ manifest: { name: 'app', dependencies: { '@guren/plugin-ai': '^0.1.0' } } })

    const lines = await infoLines(() => addAi({ provider: 'gateway' }))

    expect(lines).toContain(`Run: bun add ai@${aiPackageRange('ai')}`)
    expect(await readFile(resolve('config/ai.ts'), 'utf8')).toContain("import { createGateway } from 'ai'")
  })

  it('keeps one aiPlugin() registration across re-runs and counts a configured one', async () => {
    await seedApp()
    await writeFile('src/app.ts', APP_FIXTURE.replace('providers: []', 'providers: [aiPlugin({ approvals })]'))

    await addAi({})
    await addAi({})

    const app = await readFile(resolve('src/app.ts'), 'utf8')
    expect(app.match(/aiPlugin\(/g)).toHaveLength(1)
    expect(app.match(/config: \[ai\]/g)).toHaveLength(1)
  })

  it('refuses an unknown provider before writing anything', async () => {
    await seedApp()

    await expect(addAi({ provider: 'mistral' })).rejects.toThrow('Unknown AI provider "mistral". Choose one of: anthropic, openai, gateway.')
    expect(await fileExists(process.cwd(), 'config/ai.ts')).toBe(false)
  })

  it('refuses an app that declares no environment', async () => {
    await seedApp({ env: false })

    await expect(addAi({})).rejects.toThrow('reads its API key from config/env.ts, and this app has none')
    expect(await fileExists(process.cwd(), 'config/ai.ts')).toBe(false)
  })

  it('writes a definition the app resolves and whose env files check clean', async () => {
    await seedApp()
    await linkWorkspaceCore(process.cwd())
    await linkWorkspacePackage('plugin-ai', process.cwd())
    const anthropicLink = join(process.cwd(), 'node_modules/@ai-sdk/anthropic')
    await mkdir(dirname(anthropicLink), { recursive: true })
    await symlink(join(cliRoot, 'node_modules/@ai-sdk/anthropic'), anthropicLink, 'dir')

    await addAi({})

    const resolved = await loadResolvedConfig(process.cwd())
    expect(resolved.entries.map((entry) => [entry.key, entry.file])).toEqual([['ai', 'config/ai.ts']])
    expect((await checkEnvExample(process.cwd())).filter((result) => result.status === 'fail')).toEqual([])
  })

  // One owner per range: the `ai` an app installs is the one @guren/plugin-ai is built on.
  it('installs the ai range @guren/plugin-ai depends on', async () => {
    const plugin = JSON.parse(await readFile(join(cliRoot, '../plugin-ai/package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    expect(aiPackageRange('ai')).toBe(plugin.dependencies.ai!)
  })
})
