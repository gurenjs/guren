import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { Controller, Policy, createApp, defineNavigation, type Application, type NavigationEntry } from '../../src'
import { AUTH_CONTEXT_KEY } from '../../src/http/middleware/auth'
import { resetDefaultApplication } from '../../src/http/default-application'

class Job {}
class Report {}

const policyCalls: Array<{ ability: string; user: unknown }> = []

class JobPolicy extends Policy {
  create(user: { role?: string } | null): boolean {
    policyCalls.push({ ability: 'create', user })
    return user?.role === 'employer'
  }

  viewAny(user: unknown): boolean {
    policyCalls.push({ ability: 'viewAny', user })
    return true
  }
}

class ReportPolicy extends Policy {
  viewAny(user: { role: string } | null): boolean {
    policyCalls.push({ ability: 'viewAny', user })
    return (user as { role: string }).role === 'admin'
  }
}

class PageController extends Controller {
  async show() {
    return this.inertia('Page' as never, {} as never)
  }

  async store() {
    return this.json({ ok: true })
  }
}

interface Visit {
  readonly user?: Record<string, unknown> | null
  readonly headers?: Record<string, string>
}

async function bootWith(entries: readonly NavigationEntry[]): Promise<Application> {
  const app = createApp({
    config: [defineNavigation(entries)],
    boot: (hono) => {
      hono.use('*', async (ctx, next) => {
        const header = ctx.req.header('X-Test-User')
        const user = header === undefined ? null : JSON.parse(header) as unknown
        ;(ctx as unknown as { set(key: string, value: unknown): void }).set(AUTH_CONTEXT_KEY, { user: async () => user })
        await next()
      })
    },
    routes: (router) => {
      router.get('/', [PageController, 'show']).name('home')
      router.get('/jobs', [PageController, 'show']).name('jobs.index')
      router.get('/jobs/create', [PageController, 'show']).name('jobs.create')
      router.get('/jobsboard', [PageController, 'show']).name('jobsboard')
      router.get('/dashboard', [PageController, 'show']).name('dashboard')
      router.get('/login', [PageController, 'show']).name('login')
      router.get('/admin', [PageController, 'show']).name('admin')
      router.get('/reports', [PageController, 'show']).name('reports')
      router.get('/jobs/:id', [PageController, 'show']).name('jobs.show')
      router.post('/jobs', [PageController, 'store']).name('jobs.store')
    },
  })
  await app.boot()
  const gate = app.container.make('gate')
  gate.policy(Job, JobPolicy)
  gate.policy(Report, ReportPolicy)
  return app
}

async function visit(app: Application, path: string, options: Visit = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'X-Inertia': 'true', ...options.headers }
  if (options.user !== undefined && options.user !== null) headers['X-Test-User'] = JSON.stringify(options.user)
  const response = await app.fetch(new Request(`http://localhost${path}`, { headers }))
  expect(response.status).toBe(200)
  return ((await response.json()) as { props: Record<string, unknown> }).props
}

async function labels(app: Application, path: string, options: Visit = {}): Promise<string[]> {
  const props = await visit(app, path, options)
  return (props.navigation as Array<{ label: string }>).map((item) => item.label)
}

let warn: ReturnType<typeof spyOn>

function warnings(): string[] {
  return (warn.mock.calls as unknown[][]).map((call) => String(call[0]))
}

beforeEach(() => {
  policyCalls.length = 0
  warn = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  resetDefaultApplication()
})

describe('defineNavigation (RFC 0040 §5)', () => {
  test('shares each entry the user may see as its label, path and whether it is current, and nothing else', async () => {
    const app = await bootWith([
      { label: 'Home', route: 'home' },
      { label: 'Post a job', route: 'jobs.create', show: { auth: 'required', can: ['create', Job], where: { role: 'employer' } } },
    ])

    const props = await visit(app, '/jobs/create', { user: { id: 1, role: 'employer' } })

    expect(props.navigation).toEqual([
      { label: 'Home', path: '/', current: false },
      { label: 'Post a job', path: '/jobs/create', current: true },
    ])
  })

  test('shows an auth entry to the side it names', async () => {
    const app = await bootWith([
      { label: 'Jobs', route: 'jobs.index', show: { auth: 'any' } },
      { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },
      { label: 'Sign in', route: 'login', show: { auth: 'guest' } },
    ])

    expect(await labels(app, '/')).toEqual(['Jobs', 'Sign in'])
    expect(await labels(app, '/', { user: { id: 1 } })).toEqual(['Jobs', 'Dashboard'])
  })

  test('compares where fields by strict equality, and a guest matches none', async () => {
    const app = await bootWith([
      { label: 'Admin', route: 'admin', show: { where: { role: 'admin' } } },
      { label: 'Jobs', route: 'jobs.index', show: { where: { teamId: 1 } } },
    ])

    expect(await labels(app, '/', { user: { id: 1, role: 'admin', teamId: '1' } })).toEqual(['Admin'])
    expect(await labels(app, '/', { user: { id: 2, role: 'member', teamId: 1 } })).toEqual(['Jobs'])
    expect(await labels(app, '/')).toEqual([])
  })

  test('asks the gate with the bare class, once per ability and model, and a guest with a null user', async () => {
    const app = await bootWith([
      { label: 'Post a job', route: 'jobs.create', show: { can: ['create', Job] } },
      { label: 'Jobs board', route: 'jobsboard', show: { can: ['create', Job] } },
      { label: 'Jobs', route: 'jobs.index', show: { can: ['viewAny', Job] } },
    ])

    expect(await labels(app, '/', { user: { id: 1, role: 'employer' } })).toEqual(['Post a job', 'Jobs board', 'Jobs'])
    expect(policyCalls.map((call) => call.ability)).toEqual(['create', 'viewAny'])

    policyCalls.length = 0
    expect(await labels(app, '/')).toEqual(['Jobs'])
    expect(policyCalls).toEqual([{ ability: 'create', user: null }, { ability: 'viewAny', user: null }])
  })

  test('judges auth and where before asking the gate', async () => {
    const app = await bootWith([
      { label: 'Post a job', route: 'jobs.create', show: { auth: 'required', can: ['create', Job] } },
    ])

    expect(await labels(app, '/')).toEqual([])
    expect(policyCalls).toEqual([])
  })

  test('hides an entry whose check throws, and warns once per ability and model', async () => {
    const app = await bootWith([
      { label: 'Reports', route: 'reports', show: { can: ['viewAny', Report] } },
      { label: 'Home', route: 'home' },
    ])

    expect(await labels(app, '/')).toEqual(['Home'])
    expect(await labels(app, '/')).toEqual(['Home'])
    expect(await labels(app, '/', { user: { id: 1, role: 'admin' } })).toEqual(['Reports', 'Home'])

    const thrown = warnings().filter((message) => message.includes("can('viewAny', Report) threw"))
    expect(thrown).toHaveLength(1)
  })

  test('hides an entry whose route is missing, not a GET or has a parameter, and warns at boot', async () => {
    const app = await bootWith([
      { label: 'Gone', route: 'nowhere' },
      { label: 'Store', route: 'jobs.store' },
      { label: 'Job', route: 'jobs.show' },
      { label: 'Home', route: 'home' },
    ])

    const messages = warnings()
    expect(messages.some((message) => message.includes('"Gone" is hidden: route "nowhere" is not registered'))).toBe(true)
    expect(messages.some((message) => message.includes('"Store" is hidden: route "jobs.store" is a POST route'))).toBe(true)
    expect(messages.some((message) => message.includes('"Job" is hidden: route "jobs.show" has a path parameter'))).toBe(true)
    expect(await labels(app, '/')).toEqual(['Home'])
  })

  test('marks the entry at the request path, else the longest prefix by whole segments, and never / as a prefix', async () => {
    const app = await bootWith([
      { label: 'Home', route: 'home' },
      { label: 'Jobs', route: 'jobs.index' },
      { label: 'Post a job', route: 'jobs.create' },
    ])
    const current = async (path: string) =>
      ((await visit(app, path)).navigation as Array<{ label: string; current: boolean }>)
        .filter((item) => item.current)
        .map((item) => item.label)

    expect(await current('/')).toEqual(['Home'])
    expect(await current('/jobs')).toEqual(['Jobs'])
    expect(await current('/jobs/create')).toEqual(['Post a job'])
    expect(await current('/jobs/42')).toEqual(['Jobs'])
    expect(await current('/jobsboard')).toEqual([])
    expect(await current('/dashboard')).toEqual([])
  })

  test('is a lazy prop: a partial reload that does not ask for it runs no check', async () => {
    const app = await bootWith([{ label: 'Post a job', route: 'jobs.create', show: { can: ['create', Job] } }])
    const partial = { 'X-Inertia-Partial-Component': 'Page' }

    const skipped = await visit(app, '/', { headers: { ...partial, 'X-Inertia-Partial-Data': 'other' } })
    expect(skipped).not.toHaveProperty('navigation')
    expect(policyCalls).toEqual([])

    const asked = await visit(app, '/', { headers: { ...partial, 'X-Inertia-Partial-Data': 'navigation' } })
    expect(asked.navigation).toEqual([])
    expect(policyCalls).toHaveLength(1)
  })

  test('refuses an entry that is not one', () => {
    expect(() => defineNavigation([{ label: 'A', route: 'home' }, { label: 'B', route: 'home' }])).toThrow('names route "home" a second time')
    expect(() => defineNavigation([{ label: '', route: 'home' }])).toThrow('has no label')
    expect(() => defineNavigation([{ label: 'A', route: 'home', show: { auth: 'admin' as never } }])).toThrow('takes any, required or guest')
    expect(() => defineNavigation([{ label: 'A', route: 'home', show: { can: ['create'] as never } }])).toThrow('takes [ability, Model]')
    expect(() => defineNavigation([{ label: 'A', route: 'home', show: { role: 'x' } as never }])).toThrow('it takes auth, can and where')
    expect(() => defineNavigation([{ label: 'A', route: 'home', show: { where: { tags: ['a'] } as never } }])).toThrow('is not a string, number, boolean or null')
  })
})
