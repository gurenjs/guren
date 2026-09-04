import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runCommand } from 'citty'
import { createTempWorkspace, linkWorkspaceCore, type TempWorkspace } from './helpers'
import { builtinSubCommands } from '../src/commands'
import { runTokenIssue } from '../src/token-issue'

const repoRoot = resolve(import.meta.dir, '../../..')

/**
 * The command's I/O boundary — deriving the tool list, reaching the token store,
 * and what it prints; `token-issue.test.ts` covers the issuance rules. The app
 * lives in a *subdirectory* of the workspace so `--app` names a root the process
 * cwd is not: at the workspace root every case would pass whether or not the
 * command honoured the flag, which is what hid the store landing in a different
 * application than the tools were derived from.
 */
async function linkFixtureDependencies(dir: string): Promise<void> {
  await linkWorkspaceCore(dir)
  const zodLink = join(dir, 'node_modules', 'zod')
  await mkdir(dirname(zodLink), { recursive: true })
  await symlink(join(repoRoot, 'node_modules', 'zod'), zodLink, 'dir')
}

const ROUTES = `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => Response.json({ posts: [] })).name('posts.index').agent({})
  router.post('/posts', () => Response.json({}, { status: 201 })).name('posts.store').agent({})
  router.get('/internal', () => Response.json({})).name('internal.index').agent({ expose: { mcp: false } })
}

export default registerWebRoutes
`

const MAIN = `import { createApp, MemoryApiTokenStore } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

export const store = new MemoryApiTokenStore()

const app = createApp({ routes: registerWebRoutes })
app.auth.useTokens(store)

export default app
`

/** An app whose boot() rejects after token auth is already configured. */
const MAIN_BOOT_FAILS = `import { createApp, MemoryApiTokenStore, ServiceProvider } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

class FailingProvider extends ServiceProvider {
  register(): void {}
  override boot(): void {
    throw new Error('a later provider failed to boot')
  }
}

export const store = new MemoryApiTokenStore()

const app = createApp({ routes: registerWebRoutes, providers: [FailingProvider] })
app.auth.useTokens(store)

export default app
`

interface FixtureModule {
  store: { size: number }
}

describe('token:issue command boundary', () => {
  let workspace: TempWorkspace
  let appDir: string
  let output: string[]
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-token-issue-')
    // node_modules stays at the workspace root; bun walks up to it from the
    // app's own files.
    await linkFixtureDependencies(workspace.dir)
    appDir = join(workspace.dir, 'app')
    await mkdir(join(appDir, 'routes'), { recursive: true })
    await mkdir(join(appDir, 'src'), { recursive: true })
    await writeFile(join(appDir, 'routes/web.ts'), ROUTES)
    output = []
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    })
  })

  afterEach(async () => {
    logSpy.mockRestore()
    await workspace.cleanup()
  })

  async function fixtureStore(): Promise<FixtureModule['store']> {
    const module = (await import(pathToFileURL(join(appDir, 'src/main.ts')).href)) as FixtureModule
    return module.store
  }

  it('writes the token into the store of the app --app names', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN)

    await runTokenIssue({
      name: 'ci',
      user: '42',
      tools: 'posts.index',
      appRoot: appDir,
      json: true,
    })

    // cwd is the workspace root, which has no app of its own — before the
    // fix the entry was resolved from cwd and this could not have landed.
    expect((await fixtureStore()).size).toBe(1)
  })

  it('emits one JSON object carrying the token and its grant', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN)

    await runTokenIssue({
      name: 'ci',
      user: '42',
      tools: 'posts.*',
      appRoot: appDir,
      expires: '30d',
      json: true,
    })

    expect(output).toHaveLength(1)
    const payload = JSON.parse(output[0]!) as {
      token: string
      abilities: string[]
      granted: { readOnly: string[]; write: string[] }
      expiresAt: string | null
    }
    expect(payload.token).toContain('|')
    expect(payload.abilities).toEqual(['tools:posts.*'])
    expect(payload.granted.readOnly).toEqual(['posts.index'])
    expect(payload.granted.write).toEqual(['posts.store'])
    expect(payload.expiresAt).not.toBeNull()
  })

  it('excludes a tool that is not exposed on mcp from the grant', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN)

    // The token this mints is a bearer credential, and bearer is the App MCP
    // surface — a tool hidden from it can never be reached with this token.
    await expect(
      runTokenIssue({ name: 'ci', user: '42', tools: 'internal.index', appRoot: appDir, json: true }),
    ).rejects.toThrow('matches none of this app')
  })

  it('refuses to mint when the application boot() rejects', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN_BOOT_FAILS)

    await expect(
      runTokenIssue({ name: 'ci', user: '42', tools: 'posts.index', appRoot: appDir, json: true }),
    ).rejects.toThrow('a later provider failed to boot')

    expect((await fixtureStore()).size).toBe(0)
  })

  it('explains how to configure a store when the app has none', async () => {
    await writeFile(
      join(appDir, 'src/main.ts'),
      `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

export default createApp({ routes: registerWebRoutes })
`,
    )

    await expect(
      runTokenIssue({ name: 'ci', user: '42', tools: 'posts.index', appRoot: appDir, json: true }),
    ).rejects.toThrow('auth.useTokens(store)')
  })

  it('refuses an app that exposes no agent tools, without booting it', async () => {
    await writeFile(
      join(appDir, 'routes/web.ts'),
      `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => Response.json({})).name('posts.index')
}

export default registerWebRoutes
`,
    )
    // No src/main.ts at all: reaching the store would fail with a different
    // message, so this also pins that derivation happens first.
    await expect(
      runTokenIssue({ name: 'ci', user: '42', tools: 'posts.index', appRoot: appDir, json: true }),
    ).rejects.toThrow('no agent tools')
  })
})

/**
 * The citty layer, driven through the parser. `runTokenIssue` receives values
 * already narrowed to scalars, so it cannot see the defect these cover: citty
 * arrays a repeated flag and every array is truthy, which turned
 * `--yes=false --yes=false` into consent for a `tools:*` grant.
 */
describe('token:issue flag parsing', () => {
  let workspace: TempWorkspace
  let appDir: string
  let logSpy: ReturnType<typeof spyOn>
  let exitSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-token-flags-')
    await linkFixtureDependencies(workspace.dir)
    appDir = join(workspace.dir, 'app')
    await mkdir(join(appDir, 'routes'), { recursive: true })
    await mkdir(join(appDir, 'src'), { recursive: true })
    await writeFile(join(appDir, 'routes/web.ts'), ROUTES)
    await writeFile(join(appDir, 'src/main.ts'), MAIN)
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
    // A successful run ends in `process.exit(0)` and closes nothing it opened,
    // so success is observed as this sentinel rather than left real.
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`)
    }) as never)
  })

  afterEach(async () => {
    exitSpy.mockRestore()
    logSpy.mockRestore()
    await workspace.cleanup()
  })

  async function runFlags(rawArgs: string[]): Promise<unknown> {
    const command = builtinSubCommands['token:issue']
    return runCommand(command, { rawArgs: [...rawArgs, '--app', appDir, '--json'] })
  }

  it('still refuses tools:* when --yes is repeated as false', async () => {
    await expect(
      runFlags(['--name', 'ci', '--user', '42', '--tools', '*', '--yes=false', '--yes=false']),
    ).rejects.toThrow('--yes')
  })

  it('honours the last value of a repeated boolean rather than any false', async () => {
    // The inverse direction on a write tool: a lingering `--read-only=true`
    // would refuse `posts.store`, so reaching the success exit is the assertion.
    await expect(
      runFlags(['--name', 'ci', '--user', '42', '--tools', 'posts.store', '--read-only=true', '--read-only=false']),
    ).rejects.toThrow('process.exit(0)')
  })

  it('reads the last --tools rather than joining repeats', async () => {
    // Joined, the repeat would name neither tool and be refused; last-wins
    // issues against the second one and reaches the success exit.
    await expect(
      runFlags(['--name', 'ci', '--user', '42', '--tools', 'internal.index', '--tools', 'posts.index']),
    ).rejects.toThrow('process.exit(0)')
  })

  it('refuses a repeated --allow-unmatched that ends in false', async () => {
    await expect(
      runFlags([
        '--name', 'ci', '--user', '42', '--tools', 'billing.*',
        '--allow-unmatched=true', '--allow-unmatched=false',
      ]),
    ).rejects.toThrow('matches none of this app')
  })
})
