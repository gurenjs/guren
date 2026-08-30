import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createTempWorkspace, linkWorkspaceCore, type TempWorkspace } from './helpers'
import { runToolDev } from '../src/tool-dev'

const repoRoot = resolve(import.meta.dir, '../../..')

/**
 * `tool:dev` against real applications: what it refuses, and what it hands a
 * developer when it does not.
 *
 * The app fixture sits in a subdirectory of the workspace so `--app` names a
 * root the process cwd is not — `createTempWorkspace` chdirs into the root it
 * makes, and an app at that root would leave the two equal, so nothing here
 * would notice a command that ignored the flag.
 */
async function linkFixtureDependencies(dir: string): Promise<void> {
  await linkWorkspaceCore(dir)
  for (const pkg of ['plugin-mcp', 'server', 'orm']) {
    const link = join(dir, 'node_modules', '@guren', pkg)
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(repoRoot, 'packages', pkg), link, 'dir')
  }
  for (const pkg of ['hono', '@modelcontextprotocol']) {
    const link = join(dir, 'node_modules', pkg)
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(repoRoot, 'node_modules', pkg), link, 'dir')
  }
}

const ROUTES = `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', () => Response.json({ posts: [] })).name('posts.index').agent({})
}

export default registerWebRoutes
`

const MAIN_WITH_PLUGIN = `import { createApp, MemoryApiTokenStore } from '@guren/core'
import { mcpPlugin } from '@guren/plugin-mcp'
import { registerWebRoutes } from '../routes/web'

export const appStore = new MemoryApiTokenStore()

const app = createApp({ routes: registerWebRoutes, providers: [mcpPlugin()] })
app.auth.useTokens(appStore)

export default app
`

const MAIN_WITHOUT_PLUGIN = `import { createApp, MemoryApiTokenStore } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

const app = createApp({ routes: registerWebRoutes })
app.auth.useTokens(new MemoryApiTokenStore())

export default app
`

/** Ports for the cases that actually listen, kept apart so they can run in any order. */
let nextPort = 3610

describe('tool:dev', () => {
  let workspace: TempWorkspace
  let appDir: string
  let logSpy: ReturnType<typeof spyOn>
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-tool-dev-')
    await linkFixtureDependencies(workspace.dir)
    appDir = join(workspace.dir, 'app')
    await mkdir(join(appDir, 'routes'), { recursive: true })
    await mkdir(join(appDir, 'src'), { recursive: true })
    await writeFile(join(appDir, 'routes/web.ts'), ROUTES)
    // Silences the banner and the printout; the assertions read the returned
    // session, not the terminal.
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(async () => {
    logSpy.mockRestore()
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    await workspace.cleanup()
  })

  it('refuses to run in production', async () => {
    process.env.NODE_ENV = 'production'
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_PLUGIN)

    // It would work — the store lives in this process either way. Refusing is
    // so a mistyped deploy script stops at a message instead of listening.
    await expect(runToolDev({ appRoot: appDir })).rejects.toThrow('NODE_ENV=production')
  })

  it('names the plugin when no endpoint answers', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITHOUT_PLUGIN)

    await expect(runToolDev({ appRoot: appDir, port: nextPort++ })).rejects.toThrow(
      /No App MCP endpoint answered.*404/s,
    )
  })

  it('serves the endpoint with a token that works, without touching the app store', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_PLUGIN)
    const port = nextPort++

    const session = await runToolDev({ appRoot: appDir, port })

    expect(session.endpoint).toBe(`http://127.0.0.1:${port}/mcp`)
    const { token, endpoint } = session
    const listed = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(listed.status).toBe(200)
    expect(await listed.text()).toContain('posts.index')

    // The token was issued into this command's own store, so the app's is
    // untouched — that, not a policy, is what makes it ephemeral. Imported by
    // the same specifier the command used, with no cache-busting query: a
    // different specifier would be a different module, and its store would
    // read empty whether or not the command wrote to the app's.
    const module = (await import(pathToFileURL(join(appDir, 'src/main.ts')).href)) as {
      appStore: { size: number }
    }
    expect(module.appStore.size).toBe(0)
  })

  it('says which user tool calls authenticate as', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_PLUGIN)

    const explicit = await runToolDev({ appRoot: appDir, port: nextPort++, as: '42' })
    expect(explicit.userId).toBe('42')

    // Never a mystery: a call whose policy loads a user behaves differently
    // depending on this, so the default is a placeholder that matches no
    // record rather than a plausible id.
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_PLUGIN)
    const fallback = await runToolDev({ appRoot: appDir, port: nextPort++ })
    expect(fallback.userId).toBe('tool-dev')
  })
})
