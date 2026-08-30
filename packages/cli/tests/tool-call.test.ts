// Set before anything imports `@guren/core`: the fixture app with an auth
// stack mounts session + CSRF middleware, which need a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createTempWorkspace, linkWorkspaceCore, type TempWorkspace } from './helpers'
import { parseActingAs, parseToolInput, runToolCall } from '../src/tool-call'

const repoRoot = resolve(import.meta.dir, '../../..')

/**
 * `guren tool:call` end to end: a real application on disk, booted, dispatched
 * into, and its answer read back through the shared dispatch contract.
 *
 * The app lives in a *subdirectory* of the workspace so `--app` names a root
 * the process cwd is not — the same arrangement `token-issue-command.test.ts`
 * uses, and for the same reason: an app at the workspace root would let every
 * case pass whether or not the command honoured the flag.
 */
async function linkFixtureDependencies(dir: string): Promise<void> {
  await linkWorkspaceCore(dir)
  const zodLink = join(dir, 'node_modules', 'zod')
  await mkdir(dirname(zodLink), { recursive: true })
  await symlink(join(repoRoot, 'node_modules', 'zod'), zodLink, 'dir')
}

const ROUTES = `import { Router } from '@guren/core'
import { z } from 'zod'
import { MeController } from '../app/Http/Controllers/MeController'

export const created: string[] = []

export function registerWebRoutes(router: Router): void {
  router
    .get('/posts', { output: z.object({ posts: z.array(z.string()) }) }, () => Response.json({ posts: created }))
    .name('posts.index')
    .agent({ description: 'List posts.' })

  router
    .post(
      '/posts',
      { body: z.object({ title: z.string().min(3) }), output: z.object({ id: z.number(), title: z.string() }) },
      ({ body }) => {
        created.push(body.title)
        return Response.json({ id: created.length, title: body.title }, { status: 201 })
      },
    )
    .name('posts.store')
    .agent({ description: 'Create a post.' })

  router
    .get('/me', { output: z.object({ id: z.union([z.number(), z.string(), z.null()]) }) }, [MeController, 'show'])
    .name('me.show')
    .agent({})
}

export default registerWebRoutes
`

const CONTROLLER = `import { Controller } from '@guren/core'

export class MeController extends Controller {
  async show() {
    const user = await this.auth.user()
    return this.json({ id: user ? (user as { id: unknown }).id ?? null : null })
  }
}
`

const MAIN = `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

export default createApp({ routes: registerWebRoutes })
`

/** The same app with the default auth stack — session and CSRF middleware. */
const MAIN_WITH_AUTH = `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

export default createApp({ routes: registerWebRoutes, auth: {} })
`

describe('tool:call', () => {
  let workspace: TempWorkspace
  let appDir: string
  let output: string[]
  let logSpy: ReturnType<typeof spyOn>
  let previousExitCode: typeof process.exitCode

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-tool-call-')
    await linkFixtureDependencies(workspace.dir)
    appDir = join(workspace.dir, 'app')
    await mkdir(join(appDir, 'routes'), { recursive: true })
    await mkdir(join(appDir, 'src'), { recursive: true })
    await mkdir(join(appDir, 'app/Http/Controllers'), { recursive: true })
    await writeFile(join(appDir, 'routes/web.ts'), ROUTES)
    await writeFile(join(appDir, 'app/Http/Controllers/MeController.ts'), CONTROLLER)
    await writeFile(join(appDir, 'src/main.ts'), MAIN)
    output = []
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    })
    previousExitCode = process.exitCode
  })

  afterEach(async () => {
    logSpy.mockRestore()
    // `?? 0`, not the captured value verbatim: assigning `undefined` does not
    // clear a set exit code on Bun, so an error-result case here would leak a
    // failing exit code into the whole test run — 0 fail, exit 1.
    process.exitCode = previousExitCode ?? 0
    await workspace.cleanup()
  })

  function payload(): Record<string, unknown> {
    expect(output).toHaveLength(1)
    return JSON.parse(output[0]!) as Record<string, unknown>
  }

  it('dispatches a read tool and reports its structured result', async () => {
    await runToolCall({ name: 'posts.index', appRoot: appDir, json: true })

    const result = payload()
    expect(result.tool).toBe('posts.index')
    expect(result.status).toBe(200)
    expect(result.isError).toBe(false)
    expect(result.structuredContent).toEqual({ posts: [] })
  })

  it('sends the input as the request body and reports the created resource', async () => {
    await runToolCall({
      name: 'posts.store',
      input: '{"title":"Hello agents"}',
      appRoot: appDir,
      json: true,
    })

    const result = payload()
    expect(result.status).toBe(201)
    expect(result.structuredContent).toEqual({ id: 1, title: 'Hello agents' })
  })

  it('reports a validation failure as an error result and a non-zero exit code', async () => {
    await runToolCall({ name: 'posts.store', input: '{"title":"no"}', appRoot: appDir, json: true })

    const result = payload()
    expect(result.status).toBe(422)
    expect(result.isError).toBe(true)
    // A script asking "did this tool work" must not read a 422 as a success.
    expect(process.exitCode).toBe(1)
  })

  it('answers --preflight with a verdict and does not run the handler', async () => {
    await runToolCall({
      name: 'posts.store',
      input: '{"title":"Rehearsal"}',
      preflight: true,
      appRoot: appDir,
      json: true,
    })

    const result = payload()
    const verdict = result.preflight as Record<string, unknown>
    expect(verdict.allowed).toBe(true)
    expect(verdict.validated).toEqual(['body'])
    expect(verdict.unverified).toEqual(['authorization'])
    expect(result.preflightUnanswered).toBe(false)

    // The rehearsal must not have created anything: the list tool still sees
    // an empty collection.
    output.length = 0
    await runToolCall({ name: 'posts.index', appRoot: appDir, json: true })
    expect(payload().structuredContent).toEqual({ posts: [] })
  })

  it('authenticates as the user --as names, and as nobody without it', async () => {
    const previousTesting = process.env.GUREN_TESTING
    delete process.env.GUREN_TESTING
    try {
      await runToolCall({ name: 'me.show', appRoot: appDir, json: true })
      expect(payload().structuredContent).toEqual({ id: null })

      output.length = 0
      await runToolCall({ name: 'me.show', as: 'user:42', appRoot: appDir, json: true })
      expect(payload().structuredContent).toEqual({ id: 42 })
    } finally {
      if (previousTesting === undefined) delete process.env.GUREN_TESTING
      else process.env.GUREN_TESTING = previousTesting
    }
  })

  it('primes a CSRF token so a mutating call reaches the route', async () => {
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_AUTH)

    // A dispatched tool call carries neither a bearer token nor a cookie, so
    // the CSRF middleware refuses it unless the command performs the same
    // token round-trip a browser performs.
    await runToolCall({ name: 'posts.store', input: '{"title":"With auth"}', appRoot: appDir, json: true })

    const result = payload()
    expect(result.status).toBe(201)
    expect(result.isError).toBe(false)
  })

  it('names every tool the app exposes when the name is unknown', async () => {
    await expect(runToolCall({ name: 'posts.destroy', appRoot: appDir, json: true })).rejects.toThrow(
      /This app exposes: me\.show, posts\.index, posts\.store\./,
    )
  })

  it('quotes the input it could not parse', async () => {
    await expect(
      runToolCall({ name: 'posts.index', input: '{title: 1}', appRoot: appDir, json: true }),
    ).rejects.toThrow(/received: \{title: 1\}/)
  })
})

describe('tool:call input parsing', () => {
  it('treats an absent or blank --input as no arguments', () => {
    expect(parseToolInput(undefined)).toEqual({})
    expect(parseToolInput('  ')).toEqual({})
  })

  it('refuses JSON that is not an object', () => {
    expect(() => parseToolInput('[1,2]')).toThrow('must be a JSON object')
    expect(() => parseToolInput('"hi"')).toThrow('must be a JSON object')
    expect(() => parseToolInput('null')).toThrow('must be a JSON object')
  })

  it('quotes the offending text on a parse failure', () => {
    expect(() => parseToolInput("{'title':1}")).toThrow(/received: \{'title':1\}/)
  })
})

describe('tool:call --as', () => {
  it('accepts the user: prefix and a bare id', () => {
    expect(parseActingAs('user:42')).toBe(42)
    expect(parseActingAs('42')).toBe(42)
    // The `0042` vs `42` rule `token:issue` carries: a value that does not
    // round-trip through Number stays the string it was typed as.
    expect(parseActingAs('user:0042')).toBe('0042')
    expect(parseActingAs('user:018f-ulid')).toBe('018f-ulid')
  })

  it('refuses a prefix it has no principal for', () => {
    expect(() => parseActingAs('admin:1')).toThrow('Unknown --as prefix "admin:"')
  })

  it('refuses an empty id', () => {
    expect(() => parseActingAs('user:')).toThrow('requires an id after the prefix')
    expect(() => parseActingAs('   ')).toThrow('--as requires a user id')
  })
})
