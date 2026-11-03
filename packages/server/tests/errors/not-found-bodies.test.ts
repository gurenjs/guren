import { describe, expect, it } from 'bun:test'
import { ModelNotFoundException } from '@guren/orm'
import {
  abort,
  Controller,
  createApp,
  createExceptionHandler,
  Gate,
  HttpException,
  NotFoundHttpException,
  Policy,
  ServiceProvider,
} from '../../src'
import { renderErrorPage } from '../../src/errors/error-page'

class Project {
  static readonly recordType = {} as { id: number; ownerId: number }

  static findOrFail(id: unknown): Promise<{ id: number; ownerId: number }> {
    if (String(id) === '7') return Promise.resolve({ id: 7, ownerId: 1 })
    return Promise.reject(new ModelNotFoundException('Project', id))
  }
}

class ProjectPolicy extends Policy {
  view() {
    return this.denyAsNotFound()
  }

  update() {
    return this.denyAsNotFound('Project 7 belongs to someone else')
  }
}

const gate = new Gate()
gate.policy(Project, ProjectPolicy)

class ProjectController extends Controller {
  async show() {
    const project = await Project.findOrFail(this.request.param('id'))
    await gate.authorize('view', [Project, project])
    return this.json({ project })
  }

  async edit() {
    await gate.authorize('update', [Project, this.model(Project)])
    return this.json({ project: this.model(Project) })
  }
}

/** A developer's message through the public constructor, tagged with a resource as it naturally would be. */
class InvitationNotFound extends NotFoundHttpException {
  readonly #trace = 'trace-1'

  constructor(id: number) {
    super('That invitation has expired', 'Invitation', id)
  }

  override toResponse(debug = false) {
    const { status, body } = super.toResponse(debug)
    return { status, body: { ...body, errors: { invitation: [this.message] }, trace: this.#trace } }
  }
}

/** A 404 thrown with no message, whose `toResponse()` adds to the body and reads a private field. */
class EnvelopeNotFound extends HttpException {
  readonly #trace = 'trace-2'

  constructor() {
    super(404, '')
  }

  override toResponse(debug = false) {
    const { status, body } = super.toResponse(debug)
    return { status, body: { ...body, errors: { record: [this.message] }, trace: this.#trace } }
  }
}

/** An app's own 404 that happens to carry the field the ORM's exception does. */
class ArchivedInvoice extends Error {
  readonly statusCode = 404
  readonly modelName = 'Invoice'

  constructor() {
    super('Invoice 12 was archived')
  }
}

/** A 404 thrown with no message whose `toResponse()` writes a message of its own. */
class ExpiredInvitation extends HttpException {
  constructor() {
    super(404, '')
  }

  override toResponse() {
    return { status: 404, body: { message: 'This invitation has expired' } }
  }
}

/** A 404 whose `message` is an accessor over hidden state, which a write to it would change. */
const backedMessages = new WeakMap<object, string>()
class BackedNotFound extends HttpException {
  constructor() {
    super(404, undefined as unknown as string)
  }
}
Object.defineProperty(BackedNotFound.prototype, 'message', {
  get(this: object) {
    return backedMessages.get(this) ?? ''
  },
  set(this: object, value: string) {
    backedMessages.set(this, value)
  },
})

/**
 * Driven through `createApp()` and `app.fetch()`: each 404 below is thrown where a
 * real one is (a controller's `findOrFail()`, route model binding, a policy) and
 * rendered by the handler `ErrorServiceProvider` installs.
 */
async function appWithDebug(debug: boolean) {
  class DebugProvider extends ServiceProvider {
    register(): void {
      this.container.instance('exception.handler', createExceptionHandler({ debug }))
    }
  }

  const app = createApp({
    routes: (router) => {
      router.get('/projects/:id', [ProjectController, 'show'])
      router.get('/bound/:project', { bind: { project: Project } }, [ProjectController, 'edit'])
      router.get('/aborted', () => abort(404))
      router.get('/aborted-with-message', () => abort(404, 'That invitation has expired'))
      router.get('/for-model', () => {
        throw NotFoundHttpException.forModel('Project', 99999)
      })
      router.get('/frozen', () => {
        throw Object.freeze(NotFoundHttpException.forModel('Project', 99999))
      })
      router.get('/backed', () => {
        throw new BackedNotFound()
      })
      router.get('/expired', () => {
        throw new ExpiredInvitation()
      })
      router.get('/expired-frozen', () => {
        throw Object.freeze(new ExpiredInvitation())
      })
      router.get('/invitation', () => {
        throw new InvitationNotFound(12)
      })
      router.get('/envelope', () => {
        throw new EnvelopeNotFound()
      })
      router.get('/archived', () => {
        throw new ArchivedInvoice()
      })
    },
    providers: [DebugProvider],
  })
  await app.boot()
  return app
}

const BROWSER = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
const JSON_CALLER = { Accept: 'application/json' }
const INERTIA = { ...BROWSER, 'X-Inertia': 'true' }

async function fetchBody(app: Awaited<ReturnType<typeof appWithDebug>>, path: string, headers: Record<string, string>) {
  const response = await app.fetch(new Request(`http://example.com${path}`, { headers }))
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
}

/** The framework's own messages: a missing record, a bound one, a hidden one, `abort(404)` and `forModel()`. */
const DEFAULT_NOT_FOUND_PATHS = ['/projects/99999', '/bound/99999', '/projects/7', '/aborted', '/for-model']

describe('404 bodies outside debug', () => {
  for (const [caller, headers] of [['a JSON caller', JSON_CALLER], ['an Inertia visit', INERTIA], ['a browser', BROWSER]] as const) {
    it(`gives ${caller} one body whether the record is missing or a policy hides it`, async () => {
      const app = await appWithDebug(false)

      const responses = await Promise.all(DEFAULT_NOT_FOUND_PATHS.map((path) => fetchBody(app, path, headers)))

      for (const response of responses) {
        expect(response.status).toBe(404)
        expect(response).toEqual(responses[0]!)
      }
      expect(responses[0]!.body).not.toContain('99999')
      expect(responses[0]!.body).not.toContain('Project')
    })
  }

  it('answers a JSON caller with the generic message', async () => {
    const app = await appWithDebug(false)

    const response = await fetchBody(app, '/bound/99999', JSON_CALLER)

    expect(response.type).toContain('application/json')
    expect(JSON.parse(response.body)).toEqual({ message: 'Not Found' })
  })

  it('answers a browser with the plain 404 page', async () => {
    const app = await appWithDebug(false)

    const response = await fetchBody(app, '/projects/99999', BROWSER)

    expect(response.type).toContain('text/html')
    expect(response.body).toBe(renderErrorPage(404))
  })

  it('keeps a message the developer wrote', async () => {
    const app = await appWithDebug(false)

    const hidden = await fetchBody(app, '/bound/7', JSON_CALLER)
    const aborted = await fetchBody(app, '/aborted-with-message', JSON_CALLER)
    const page = await fetchBody(app, '/aborted-with-message', BROWSER)

    expect(JSON.parse(hidden.body)).toEqual({ message: 'Project 7 belongs to someone else' })
    expect(JSON.parse(aborted.body)).toEqual({ message: 'That invitation has expired' })
    expect(page.body).toBe(renderErrorPage(404, 'That invitation has expired'))
  })

  // `resourceType` and `modelName` are public fields any 404 may carry; only the framework's own construction counts.
  it('keeps a message the developer wrote on an error tagged with a resource or a model name', async () => {
    const app = await appWithDebug(false)

    const invitation = await fetchBody(app, '/invitation', JSON_CALLER)
    const archived = await fetchBody(app, '/archived', JSON_CALLER)

    expect(JSON.parse(invitation.body)).toEqual({
      message: 'That invitation has expired',
      errors: { invitation: ['That invitation has expired'] },
      trace: 'trace-1',
    })
    expect(JSON.parse(archived.body)).toEqual({ message: 'Invoice 12 was archived' })
  })

  // The nested value is the error's own message, empty here, so it names no record.
  it("replaces only the top-level message in a subclass's toResponse() shape", async () => {
    const app = await appWithDebug(false)

    const response = await fetchBody(app, '/envelope', JSON_CALLER)

    expect(JSON.parse(response.body)).toEqual({
      message: 'Not Found',
      errors: { record: [''] },
      trace: 'trace-2',
    })
  })

  it("keeps a message toResponse() writes itself, frozen or not", async () => {
    const app = await appWithDebug(false)

    for (const path of ['/expired', '/expired-frozen']) {
      const response = await fetchBody(app, path, JSON_CALLER)

      expect(response.status).toBe(404)
      expect(JSON.parse(response.body)).toEqual({ message: 'This invitation has expired' })
    }
  })

  it('answers the generic body for a frozen error and an accessor-backed message', async () => {
    const app = await appWithDebug(false)

    for (const path of ['/frozen', '/backed']) {
      const response = await fetchBody(app, path, JSON_CALLER)

      expect(response.status).toBe(404)
      expect(JSON.parse(response.body)).toEqual({ message: 'Not Found' })
    }
  })
})

describe('404 bodies in debug', () => {
  it('keeps the message that names the model and key', async () => {
    const app = await appWithDebug(true)

    const missing = await fetchBody(app, '/bound/99999', JSON_CALLER)
    const page = await fetchBody(app, '/projects/99999', BROWSER)
    const frozen = await fetchBody(app, '/frozen', JSON_CALLER)

    expect(JSON.parse(missing.body)).toMatchObject({ message: 'Project not found for id=99999' })
    expect(page.body).toContain('Project not found for id=99999')
    expect(JSON.parse(frozen.body)).toMatchObject({ message: 'Project with ID 99999 not found.' })
  })

  it('reports a policy that hides a record as a NotFoundHttpException', async () => {
    const app = await appWithDebug(true)

    const hidden = await fetchBody(app, '/bound/7', JSON_CALLER)

    expect(hidden.status).toBe(404)
    expect(JSON.parse(hidden.body)).toMatchObject({
      message: 'Project 7 belongs to someone else',
      exception: 'NotFoundHttpException',
    })
  })
})

describe('404 messages on the exception', () => {
  it('gives denyAsNotFound() and abort(404) the message HttpException.notFound() has', () => {
    expect(new ProjectPolicy().view().message).toBe(HttpException.notFound().message)
    expect(() => abort(404)).toThrow(HttpException.notFound().message)
  })

  it('leaves the message of an exception the handler rendered untouched', async () => {
    const handler = createExceptionHandler({ debug: false })
    const forModel = NotFoundHttpException.forModel('Project', 99999)
    const frozen = Object.freeze(NotFoundHttpException.forModel('Project', 99999))
    const backed = new BackedNotFound()
    const ctx = { json: (body: unknown, status: number) => Response.json(body, { status }) }

    const responses = await Promise.all([forModel, frozen, backed].map((error) => handler.handle(error, ctx as never)))

    for (const response of responses) expect(await response.json()).toEqual({ message: 'Not Found' })
    expect(forModel.message).toBe('Project with ID 99999 not found.')
    expect(frozen.message).toBe('Project with ID 99999 not found.')
    expect(backed.message).toBe('')
    expect(backedMessages.has(backed)).toBe(false)
  })
})
