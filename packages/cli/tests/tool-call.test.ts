// Set before anything imports `@guren/core`: the fixture app with an auth
// stack mounts session + CSRF middleware, which need a signing key.
process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
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

/**
 * A route whose `.agent({ redact })` names a field the framework's own
 * sensitive-fragment list does *not* cover.
 *
 * That choice is what gives the redaction assertion below any power. A test
 * using `password` passes whether or not the route's list was threaded
 * through — the built-in fragments mask it either way — and a review of the
 * MCP surface found exactly that hole. `note` matches no default fragment, so
 * a mask on it can only have come from this declaration.
 */
const AUDITED_ROUTES = `import { Router } from '@guren/core'
import { z } from 'zod'

export function registerWebRoutes(router: Router): void {
  router
    .post(
      '/notes',
      { body: z.object({ title: z.string(), note: z.string() }), output: z.object({ ok: z.boolean() }) },
      () => Response.json({ ok: true }, { status: 201 }),
    )
    .name('notes.store')
    .agent({ description: 'File a note.', redact: ['note'] })
}
`

/**
 * An application that configured an audit trail, without an MCP endpoint.
 *
 * The binding is what `guren tool:call` reaches, so a fixture that binds it
 * directly tests exactly the seam — and can do so in a workspace where only
 * `@guren/core` is linked. `@guren/plugin-mcp`'s own suite covers that its
 * `audit` option produces this binding; nothing is being faked here that the
 * plugin does differently.
 */
const MAIN_WITH_AUDIT = `import { appendFileSync } from 'node:fs'
import { ServiceProvider, createApp, createAuditEmitter } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

class AuditProvider extends ServiceProvider {
  register() {
    const emit = createAuditEmitter(
      (record) => appendFileSync(process.env.GUREN_TEST_AUDIT_FILE, JSON.stringify(record) + '\\n'),
      undefined,
    )
    this.container.instance('agent.audit', emit)
  }
}

export default createApp({ routes: registerWebRoutes, providers: [AuditProvider] })
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

/** CSRF whose cookie path is not absolute, so RFC 6265 reads it as `/`. */
const MAIN_WITH_RELATIVE_CSRF_PATH = `import { createApp, createCsrfMiddleware } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

const app = createApp({ routes: registerWebRoutes })
app.use(createCsrfMiddleware({ cookieOptions: { path: 'admin' } }))

export default app
`

/** CSRF configured to scope its cookie to a path the tools do not sit under. */
const MAIN_WITH_SCOPED_CSRF = `import { createApp, createCsrfMiddleware } from '@guren/core'
import { registerWebRoutes } from '../routes/web'

const app = createApp({ routes: registerWebRoutes })
app.use(createCsrfMiddleware({ cookieOptions: { path: '/admin' } }))

export default app
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

  it('withholds a cookie scoped to a path the tool does not sit under', async () => {
    // Presenting more than a browser would is the one direction that could
    // turn a real CSRF misconfiguration into a green run here, so Path is
    // honoured: this app scopes its XSRF cookie to /admin, and the tool is
    // not under it.
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_SCOPED_CSRF)

    await runToolCall({ name: 'posts.store', input: '{"title":"Scoped"}', appRoot: appDir, json: true })

    const result = payload()
    expect(result.status).toBe(403)
  })

  it('sends a cookie whose Path is not absolute, which scopes it to the root', async () => {
    // RFC 6265: a Path that is not absolute is no scope at all and falls back
    // to the default path of the request that set it. Reading `admin` as a
    // scope would withhold a cookie a browser sends, and turn a working app
    // into a 403 nobody can explain.
    await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_RELATIVE_CSRF_PATH)

    await runToolCall({ name: 'posts.store', input: '{"title":"Relative"}', appRoot: appDir, json: true })

    expect(payload().status).toBe(201)
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

  /**
   * RFC 0016 §5.2 on this surface: `'cli'` is one of the four, and this
   * command is the whole of it. A developer calling a write tool as any user
   * they like is precisely the event a trail exists to hold, and until now it
   * held nothing.
   */
  describe('the audit trail', () => {
    let auditFile: string
    let previousAuditFile: string | undefined

    beforeEach(async () => {
      auditFile = join(workspace.dir, 'agent-audit.log')
      previousAuditFile = process.env.GUREN_TEST_AUDIT_FILE
      process.env.GUREN_TEST_AUDIT_FILE = auditFile
      await writeFile(join(appDir, 'routes/web.ts'), AUDITED_ROUTES)
      await writeFile(join(appDir, 'src/main.ts'), MAIN_WITH_AUDIT)
    })

    afterEach(() => {
      if (previousAuditFile === undefined) delete process.env.GUREN_TEST_AUDIT_FILE
      else process.env.GUREN_TEST_AUDIT_FILE = previousAuditFile
    })

    /** Every record the fixture's sink wrote, in order. */
    async function records(): Promise<Record<string, unknown>[]> {
      let text: string
      try {
        text = await readFile(auditFile, 'utf8')
      } catch (error) {
        // A trail that was never opened is an empty one here, not a failure:
        // the "records nothing" case below asserts exactly this.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
      return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Record<string, unknown>)
    }

    it('records the call through the emitter the application bound', async () => {
      await runToolCall({
        name: 'notes.store',
        input: '{"title":"Visible","note":"private"}',
        appRoot: appDir,
        json: true,
      })

      const written = await records()
      expect(written).toHaveLength(1)
      const [record] = written
      expect(record).toMatchObject({
        outcome: 'invoked',
        surface: 'cli',
        tool: 'notes.store',
        status: 201,
        // Nothing authenticated the call, and a record claiming a user where
        // none was named would be worse than one saying so.
        principal: null,
      })
      // Exact, not a `toMatchObject` on `note` alone: this catches the mask
      // going missing *and* the whole payload being masked, which a
      // sensitive-fragment list that grew a stray empty entry would do.
      expect(record!.arguments).toEqual({ title: 'Visible', note: '[REDACTED]' })
      expect(typeof record!.durationMs).toBe('number')
      expect(record!.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it('records the user a --as call acted as, and claims no abilities for it', async () => {
      const previousTesting = process.env.GUREN_TESTING
      try {
        await runToolCall({
          name: 'notes.store',
          input: '{"title":"As someone","note":"private"}',
          as: 'user:42',
          appRoot: appDir,
          json: true,
        })
      } finally {
        if (previousTesting === undefined) delete process.env.GUREN_TESTING
        else process.env.GUREN_TESTING = previousTesting
      }

      const [record] = await records()
      // Who the app acted as is the fact this trail most needs; `surface: 'cli'`
      // is what carries the standing caveat that no credential was verified.
      expect(record!.principal).toEqual({ kind: 'user', id: 42 })
      // `abilities` are a token's, and there was no token. An empty array
      // would be a claim about a credential that does not exist.
      expect(record!.principal).not.toHaveProperty('abilities')
    })

    it('records the status of a call the application refused', async () => {
      // A 422 is an invocation, not a denial: the request was sent and the
      // application answered it. The four denial reasons name adapter checks
      // this surface does not run.
      await runToolCall({ name: 'notes.store', input: '{"title":"Only a title"}', appRoot: appDir, json: true })

      const [record] = await records()
      expect(record).toMatchObject({ outcome: 'invoked', surface: 'cli', tool: 'notes.store', status: 422 })
    })

    it('records a rehearsal as guren.preflight, not as the tool it rehearsed', async () => {
      // The distinction the App MCP endpoint already draws, and the one this
      // surface most needs: `--preflight` stops before the handler, so a record
      // naming `notes.store` with a success status would be indistinguishable
      // from a write that happened. The probed tool rides in the arguments.
      await runToolCall({
        name: 'notes.store',
        input: '{"title":"Rehearsed","note":"private"}',
        preflight: true,
        appRoot: appDir,
        json: true,
      })

      const [record] = await records()
      expect(record).toMatchObject({ outcome: 'invoked', surface: 'cli', tool: 'guren.preflight' })
      // The checked tool's own `redact` list still masks the payload it was
      // checked with, one level down inside `input`.
      expect(record!.arguments).toEqual({
        tool: 'notes.store',
        input: { title: 'Rehearsed', note: '[REDACTED]' },
      })
    })

    it('records nothing, and still answers, when the app configured no sink', async () => {
      // The absence is the same one the MCP endpoint has with no `audit`
      // option: no binding, no trail, and no second sink invented here.
      await writeFile(join(appDir, 'src/main.ts'), MAIN)

      await runToolCall({ name: 'notes.store', input: '{"title":"Quiet","note":"private"}', appRoot: appDir, json: true })

      expect(payload().status).toBe(201)
      expect(await records()).toEqual([])
    })
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
