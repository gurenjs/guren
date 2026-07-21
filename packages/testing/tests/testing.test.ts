import { describe, it, expect, beforeEach } from 'vitest'
import {
  TestResponse,
  TestRequestBuilder,
  TestClient,
  TestApp,
  createTestClient,
  FakeQueue,
  fakeQueue,
  FakeMail,
  fakeMail,
  FakeEvent,
  fakeEvent,
  DatabaseAssertions,
  createDatabaseAssertions,
  setTestDatabase,
} from '../src'
import {
  Event,
  Job,
  attachAuthContext,
  requireAuthenticated,
  createSessionMiddleware,
  getSessionFromContext,
} from '@guren/server'
import { Hono } from 'hono'

describe('TestResponse', () => {
  function createResponse(body: string, init: ResponseInit = {}): TestResponse {
    // Null-body statuses reject any body (even '') in Node's Response.
    const nullBodyStatuses = [101, 204, 205, 304]
    const content = nullBodyStatuses.includes(init.status ?? 200) ? null : body
    return new TestResponse(new Response(content, init))
  }

  function createJsonResponse(data: unknown, init: ResponseInit = {}): TestResponse {
    return new TestResponse(
      new Response(JSON.stringify(data), {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers as Record<string, string> ?? {}),
        },
      })
    )
  }

  describe('status assertions', () => {
    it('assertStatus passes for correct status', () => {
      const response = createResponse('OK', { status: 200 })
      expect(() => response.assertStatus(200)).not.toThrow()
    })

    it('assertStatus fails for wrong status', () => {
      const response = createResponse('OK', { status: 200 })
      expect(() => response.assertStatus(201)).toThrow('Expected status 201, got 200')
    })

    it('assertOk passes for 200', () => {
      const response = createResponse('OK', { status: 200 })
      expect(() => response.assertOk()).not.toThrow()
    })

    it('assertCreated passes for 201', () => {
      const response = createResponse('', { status: 201 })
      expect(() => response.assertCreated()).not.toThrow()
    })

    it('assertNoContent passes for 204', () => {
      const response = createResponse('', { status: 204 })
      expect(() => response.assertNoContent()).not.toThrow()
    })

    it('assertUnauthorized passes for 401', () => {
      const response = createResponse('', { status: 401 })
      expect(() => response.assertUnauthorized()).not.toThrow()
    })

    it('assertForbidden passes for 403', () => {
      const response = createResponse('', { status: 403 })
      expect(() => response.assertForbidden()).not.toThrow()
    })

    it('assertNotFound passes for 404', () => {
      const response = createResponse('', { status: 404 })
      expect(() => response.assertNotFound()).not.toThrow()
    })

    it('assertSuccessful passes for 2xx', () => {
      expect(() => createResponse('', { status: 200 }).assertSuccessful()).not.toThrow()
      expect(() => createResponse('', { status: 201 }).assertSuccessful()).not.toThrow()
      expect(() => createResponse('', { status: 204 }).assertSuccessful()).not.toThrow()
    })

    it('assertSuccessful fails for non-2xx', () => {
      expect(() => createResponse('', { status: 400 }).assertSuccessful()).toThrow()
    })
  })

  describe('redirect assertions', () => {
    it('assertRedirect passes for redirect status', () => {
      const response = createResponse('', {
        status: 302,
        headers: { Location: '/home' },
      })
      expect(() => response.assertRedirect()).not.toThrow()
    })

    it('assertRedirect passes for specific URL', () => {
      const response = createResponse('', {
        status: 302,
        headers: { Location: '/home' },
      })
      expect(() => response.assertRedirect('/home')).not.toThrow()
    })

    it('assertRedirect fails for wrong URL', () => {
      const response = createResponse('', {
        status: 302,
        headers: { Location: '/home' },
      })
      expect(() => response.assertRedirect('/other')).toThrow()
    })

    it('assertRedirect fails for non-redirect status', () => {
      const response = createResponse('', { status: 200 })
      expect(() => response.assertRedirect()).toThrow()
    })
  })

  describe('header assertions', () => {
    it('assertHeader passes for existing header', () => {
      const response = createResponse('', {
        headers: { 'X-Custom': 'value' },
      })
      expect(() => response.assertHeader('X-Custom')).not.toThrow()
    })

    it('assertHeader passes for header with value', () => {
      const response = createResponse('', {
        headers: { 'X-Custom': 'value' },
      })
      expect(() => response.assertHeader('X-Custom', 'value')).not.toThrow()
    })

    it('assertHeader fails for missing header', () => {
      const response = createResponse('', {})
      expect(() => response.assertHeader('X-Custom')).toThrow()
    })

    it('assertHeaderMissing passes for missing header', () => {
      const response = createResponse('', {})
      expect(() => response.assertHeaderMissing('X-Custom')).not.toThrow()
    })
  })

  describe('JSON assertions', () => {
    it('assertJson passes for matching JSON', async () => {
      const response = createJsonResponse({ name: 'John' })
      await expect(response.assertJson({ name: 'John' })).resolves.toBe(response)
    })

    it('assertJson fails for non-matching JSON', async () => {
      const response = createJsonResponse({ name: 'John' })
      await expect(response.assertJson({ name: 'Jane' })).rejects.toThrow()
    })

    it('assertJsonPath passes for correct path value', async () => {
      const response = createJsonResponse({ user: { name: 'John' } })
      await expect(response.assertJsonPath('user.name', 'John')).resolves.toBe(response)
    })

    it('assertJsonPath fails for wrong path value', async () => {
      const response = createJsonResponse({ user: { name: 'John' } })
      await expect(response.assertJsonPath('user.name', 'Jane')).rejects.toThrow()
    })

    it('assertJsonContains passes for partial match', async () => {
      const response = createJsonResponse({ name: 'John', age: 30 })
      await expect(response.assertJsonContains({ name: 'John' })).resolves.toBe(response)
    })
  })

  describe('body assertions', () => {
    it('assertBodyContains passes when text found', async () => {
      const response = createResponse('<h1>Hello World</h1>')
      await expect(response.assertBodyContains('Hello')).resolves.toBe(response)
    })

    it('assertBodyContains fails when text not found', async () => {
      const response = createResponse('<h1>Hello World</h1>')
      await expect(response.assertBodyContains('Goodbye')).rejects.toThrow()
    })
  })
})

describe('TestRequestBuilder', () => {
  it('builds request with headers', async () => {
    let capturedRequest: Request | null = null

    const builder = new TestRequestBuilder(
      'http://localhost/test',
      'GET',
      async (req) => {
        capturedRequest = req
        return new Response('OK')
      }
    )

    await builder
      .withHeader('X-Custom', 'value')
      .withHeaders({ Accept: 'application/json' })
      .send()

    expect(capturedRequest!.headers.get('X-Custom')).toBe('value')
    expect(capturedRequest!.headers.get('Accept')).toBe('application/json')
  })

  it('builds request with JSON body', async () => {
    let capturedRequest: Request | null = null

    const builder = new TestRequestBuilder(
      'http://localhost/test',
      'POST',
      async (req) => {
        capturedRequest = req
        return new Response('OK')
      }
    )

    await builder.withJson({ name: 'John' }).send()

    expect(capturedRequest!.headers.get('Content-Type')).toBe('application/json')
    expect(await capturedRequest!.json()).toEqual({ name: 'John' })
  })

  it('builds request with form body', async () => {
    let capturedRequest: Request | null = null

    const builder = new TestRequestBuilder(
      'http://localhost/test',
      'POST',
      async (req) => {
        capturedRequest = req
        return new Response('OK')
      }
    )

    await builder.withForm({ name: 'John' }).send()

    expect(capturedRequest!.headers.get('Content-Type')).toBe(
      'application/x-www-form-urlencoded'
    )
  })

  it('builds request with cookies', async () => {
    let capturedRequest: Request | null = null

    const builder = new TestRequestBuilder(
      'http://localhost/test',
      'GET',
      async (req) => {
        capturedRequest = req
        return new Response('OK')
      }
    )

    await builder.withCookie('session', 'abc123').send()

    expect(capturedRequest!.headers.get('Cookie')).toBe('session=abc123')
  })

  it('tracks acting user', () => {
    const builder = new TestRequestBuilder(
      'http://localhost/test',
      'GET',
      async () => new Response('OK')
    )

    const user = {
      id: 1,
      email: 'test@example.com',
      getAuthIdentifier() {
        return this.id
      },
      getAuthPassword() {
        return 'secret'
      },
    }
    builder.actingAs(user)

    const details = builder.getRequestDetails()
    expect(details.user).toBe(user)
  })
})

describe('TestClient', () => {
  it('creates request builders for all methods', () => {
    const client = createTestClient(async () => new Response('OK'))

    expect(client.get('/test')).toBeInstanceOf(TestRequestBuilder)
    expect(client.post('/test')).toBeInstanceOf(TestRequestBuilder)
    expect(client.put('/test')).toBeInstanceOf(TestRequestBuilder)
    expect(client.patch('/test')).toBeInstanceOf(TestRequestBuilder)
    expect(client.delete('/test')).toBeInstanceOf(TestRequestBuilder)
  })

  it('uses base URL', async () => {
    let capturedUrl = ''

    const client = createTestClient(
      async (req) => {
        capturedUrl = req.url
        return new Response('OK')
      },
      'http://example.com'
    )

    await client.get('/api/users').send()

    expect(capturedUrl).toBe('http://example.com/api/users')
  })

  it('applies default headers', async () => {
    let capturedRequest: Request | null = null

    const client = createTestClient(async (req) => {
      capturedRequest = req
      return new Response('OK')
    })

    client.setDefaultHeaders({ Authorization: 'Bearer token' })

    await client.get('/test').send()

    expect(capturedRequest!.headers.get('Authorization')).toBe('Bearer token')
  })
})

describe('TestApp', () => {
  it('passes route registrars through to the application bootstrap', async () => {
    const app = await TestApp.create({
      routes: (router) => {
        router.get('/health', () => new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        }))
      },
    })

    await app.get('/health').assertOk().assertJson({ ok: true })
  })

  it('create({ auth }) mounts session + CSRF middleware like createApp', async () => {
    const originalAppKey = process.env.APP_KEY
    process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    try {
      const app = await TestApp.create({
        auth: {},
        routes: (router) => {
          router.get('/form', () => new Response('ok'))
          router.post('/submit', () => new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
          }))
        },
      })

      // Without a CSRF token the mutating request is rejected (403, per
      // createCsrfMiddleware's default).
      const blocked = await app.post('/submit', { title: 'x' })
      expect(blocked.status).toBe(403)

      // withCsrf() primes session + XSRF-TOKEN, after which the mutation passes.
      const csrf = await app.withCsrf('/form')
      await csrf.post('/submit', { title: 'x' }).assertOk()
    } finally {
      if (originalAppKey === undefined) {
        delete process.env.APP_KEY
      } else {
        process.env.APP_KEY = originalAppKey
      }
    }
  })

  it('create() without auth leaves CSRF unmounted', async () => {
    const app = await TestApp.create({
      routes: (router) => {
        router.post('/submit', () => new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        }))
      },
    })

    await app.post('/submit', { title: 'x' }).assertOk()
  })

  it('actingAs authenticates requests through auth middleware', async () => {
    const app = new Hono()
    app.use('*', attachAuthContext(() => ({
      check: async () => false,
      guest: async () => true,
      user: async () => null,
      userOrFail: async () => { throw new Error('Unauthenticated.') },
      id: async () => null,
      login: async () => {},
      attempt: async () => false,
      logout: async () => {},
      guard: () => {
        throw new Error('not used in test')
      },
      session: () => undefined,
    })))
    app.use('/protected', requireAuthenticated())
    app.get('/protected', (c) => c.json({ ok: true }))

    const testApp = TestApp.fromFetch((request) => app.fetch(request))
    const user = {
      id: 1,
      getAuthIdentifier() {
        return this.id
      },
      getAuthPassword() {
        return null
      },
    }

    const response = await testApp.actingAs(user).get('/protected')
    expect(response.status).toBe(200)
  })

  it('withHeaders sends custom headers on every request', async () => {
    const app = new Hono()
    app.get('/echo', (c) => c.json({
      lang: c.req.header('Accept-Language') ?? null,
      cookie: c.req.header('Cookie') ?? null,
    }))

    const testApp = TestApp.fromFetch((request) => app.fetch(request))
    const localized = testApp.withHeaders({ 'Accept-Language': 'en', Cookie: 'locale=en' })

    await localized.get('/echo').assertJson({ lang: 'en', cookie: 'locale=en' })
    // The original instance is unchanged
    await testApp.get('/echo').assertJson({ lang: null, cookie: null })
  })

  it('withSession hydrates the server-side session through session middleware', async () => {
    process.env.APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
    process.env.GUREN_TESTING = '1'
    const app = new Hono()
    app.use('*', createSessionMiddleware({ cookieSecure: false }))
    app.get('/session', (c) => c.json(getSessionFromContext(c)?.all() ?? {}))

    const client = createTestClient((request) => Promise.resolve(app.fetch(request)))
    const response = await client
      .get('/session')
      .withSession({ step: 2, wizard: 'shipping' })
      .send()

    expect(await response.json()).toEqual({ step: 2, wizard: 'shipping' })
  })

  it('withHeader composes with actingAs', async () => {
    const app = new Hono()
    app.get('/echo', (c) => c.json({
      lang: c.req.header('Accept-Language') ?? null,
      user: c.req.header('X-Testing-User') !== undefined,
    }))

    const testApp = TestApp.fromFetch((request) => app.fetch(request))
    const response = await testApp
      .actingAs({ id: 1 })
      .withHeader('Accept-Language', 'ja')
      .get('/echo')

    expect(await response.json()).toEqual({ lang: 'ja', user: true })
  })
})

describe('FakeQueue', () => {
  let queue: FakeQueue

  // Mock job class
  class SendEmailJob extends Job<{ to: string }> {
    async handle(_payload: { to: string }): Promise<void> {}
  }

  class ProcessOrderJob extends Job<{ orderId: number }> {
    async handle(_payload: { orderId: number }): Promise<void> {}
  }

  beforeEach(() => {
    queue = fakeQueue()
  })

  describe('recording', () => {
    it('records job dispatches', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })

      expect(queue.all()).toHaveLength(1)
      expect(queue.all()[0].payload).toEqual({ to: 'test@example.com' })
    })

    it('records multiple jobs', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })
      queue.record(ProcessOrderJob, { orderId: 123 })

      expect(queue.all()).toHaveLength(2)
    })
  })

  describe('assertions', () => {
    it('assertPushed passes when job was pushed', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })

      expect(() => queue.assertPushed(SendEmailJob)).not.toThrow()
    })

    it('assertPushed fails when job was not pushed', () => {
      expect(() => queue.assertPushed(SendEmailJob)).toThrow(
        'Expected job [SendEmailJob] to be pushed'
      )
    })

    it('assertPushed with callback', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })

      expect(() =>
        queue.assertPushed<{ to: string }>(SendEmailJob, (p) => p.to === 'test@example.com')
      ).not.toThrow()

      expect(() =>
        queue.assertPushed<{ to: string }>(SendEmailJob, (p) => p.to === 'other@example.com')
      ).toThrow()
    })

    it('assertPushedTimes passes for correct count', () => {
      queue.record(SendEmailJob, { to: 'a@example.com' })
      queue.record(SendEmailJob, { to: 'b@example.com' })

      expect(() => queue.assertPushedTimes(SendEmailJob, 2)).not.toThrow()
    })

    it('assertPushedTimes fails for wrong count', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })

      expect(() => queue.assertPushedTimes(SendEmailJob, 2)).toThrow()
    })

    it('assertNotPushed passes when job was not pushed', () => {
      expect(() => queue.assertNotPushed(SendEmailJob)).not.toThrow()
    })

    it('assertNotPushed fails when job was pushed', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })

      expect(() => queue.assertNotPushed(SendEmailJob)).toThrow()
    })

    it('assertNothingPushed passes when queue is empty', () => {
      expect(() => queue.assertNothingPushed()).not.toThrow()
    })

    it('assertNothingPushed fails when jobs were pushed', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })

      expect(() => queue.assertNothingPushed()).toThrow()
    })
  })

  describe('querying', () => {
    it('pushed returns jobs of specific type', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })
      queue.record(ProcessOrderJob, { orderId: 123 })

      const emailJobs = queue.pushed<{ to: string }>(SendEmailJob)
      expect(emailJobs).toHaveLength(1)
      expect(emailJobs[0].payload.to).toBe('test@example.com')
    })

    it('clear removes all jobs', () => {
      queue.record(SendEmailJob, { to: 'test@example.com' })
      queue.clear()

      expect(queue.all()).toHaveLength(0)
    })
  })
})

describe('FakeMail', () => {
  let mail: FakeMail

  beforeEach(() => {
    mail = fakeMail()
  })

  describe('recording', () => {
    it('records sent mails', () => {
      mail.record({
        to: [{ email: 'test@example.com' }],
        subject: 'Test',
        html: '<p>Hello</p>',
      })

      expect(mail.sent()).toHaveLength(1)
    })
  })

  describe('assertions', () => {
    it('assertSent passes when mail was sent', () => {
      mail.record({
        to: [{ email: 'test@example.com' }],
        subject: 'Test',
        html: '<p>Hello</p>',
      })

      expect(() => mail.assertSent()).not.toThrow()
    })

    it('assertSent fails when no mail was sent', () => {
      expect(() => mail.assertSent()).toThrow('Expected a mail to be sent')
    })

    it('assertSent with callback', () => {
      mail.record({
        to: [{ email: 'test@example.com' }],
        subject: 'Test',
        html: '<p>Hello</p>',
      })

      expect(() =>
        mail.assertSent((m) => m.subject === 'Test')
      ).not.toThrow()

      expect(() =>
        mail.assertSent((m) => m.subject === 'Other')
      ).toThrow()
    })

    it('assertSentTimes passes for correct count', () => {
      mail.record({ to: [{ email: 'a@example.com' }], subject: 'A', html: '' })
      mail.record({ to: [{ email: 'b@example.com' }], subject: 'B', html: '' })

      expect(() => mail.assertSentTimes(2)).not.toThrow()
    })

    it('assertNothingSent passes when no mail sent', () => {
      expect(() => mail.assertNothingSent()).not.toThrow()
    })

    it('assertNothingSent fails when mail was sent', () => {
      mail.record({ to: [{ email: 'test@example.com' }], subject: 'Test', html: '' })

      expect(() => mail.assertNothingSent()).toThrow()
    })

    it('assertSentTo passes for correct recipient', () => {
      mail.record({ to: [{ email: 'test@example.com' }], subject: 'Test', html: '' })

      expect(() => mail.assertSentTo('test@example.com')).not.toThrow()
    })

    it('assertSentTo fails for wrong recipient', () => {
      mail.record({ to: [{ email: 'test@example.com' }], subject: 'Test', html: '' })

      expect(() => mail.assertSentTo('other@example.com')).toThrow()
    })

    it('assertSentTo handles array of recipients', () => {
      mail.record({
        to: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
        subject: 'Test',
        html: '',
      })

      expect(() => mail.assertSentTo('b@example.com')).not.toThrow()
    })

    it('assertSentWithSubject passes for correct subject', () => {
      mail.record({ to: [{ email: 'test@example.com' }], subject: 'Welcome!', html: '' })

      expect(() => mail.assertSentWithSubject('Welcome!')).not.toThrow()
    })

    it('assertSentWithBodyContaining passes when text found', () => {
      mail.record({
        to: [{ email: 'test@example.com' }],
        subject: 'Test',
        html: '<p>Hello World</p>',
      })

      expect(() => mail.assertSentWithBodyContaining('Hello')).not.toThrow()
    })
  })

  describe('querying', () => {
    it('sentTo filters by recipient', () => {
      mail.record({ to: [{ email: 'a@example.com' }], subject: 'A', html: '' })
      mail.record({ to: [{ email: 'b@example.com' }], subject: 'B', html: '' })

      const sent = mail.sentTo('a@example.com')
      expect(sent).toHaveLength(1)
      expect(sent[0].message.subject).toBe('A')
    })

    it('clear removes all mails', () => {
      mail.record({ to: [{ email: 'test@example.com' }], subject: 'Test', html: '' })
      mail.clear()

      expect(mail.sent()).toHaveLength(0)
    })
  })
})

describe('DatabaseAssertions', () => {
  // Mock database connection
  const mockDb = {
    data: [] as Record<string, unknown>[],
    query: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('COUNT(*)')) {
        const count = mockDb.data.filter((row) => {
          if (!params || params.length === 0) return true
          return params.every((p) => Object.values(row).includes(p))
        }).length
        return [{ count }] as T[]
      }
      return mockDb.data.filter((row) => {
        if (!params || params.length === 0) return true
        return params.every((p) => Object.values(row).includes(p))
      }) as T[]
    },
    execute: async () => {},
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
  }

  let assertions: DatabaseAssertions

  beforeEach(() => {
    mockDb.data = []
    assertions = createDatabaseAssertions(mockDb)
    setTestDatabase(mockDb)
  })

  describe('assertHas', () => {
    it('passes when record exists', async () => {
      mockDb.data = [{ id: 1, name: 'John' }]

      await expect(
        assertions.assertHas('users', { name: 'John' })
      ).resolves.toBeUndefined()
    })

    it('fails when record does not exist', async () => {
      mockDb.data = []

      await expect(
        assertions.assertHas('users', { name: 'John' })
      ).rejects.toThrow()
    })
  })

  describe('assertMissing', () => {
    it('passes when record does not exist', async () => {
      mockDb.data = []

      await expect(
        assertions.assertMissing('users', { name: 'John' })
      ).resolves.toBeUndefined()
    })

    it('fails when record exists', async () => {
      mockDb.data = [{ id: 1, name: 'John' }]

      await expect(
        assertions.assertMissing('users', { name: 'John' })
      ).rejects.toThrow()
    })
  })

  describe('assertCount', () => {
    it('passes for correct count', async () => {
      mockDb.data = [{ id: 1 }, { id: 2 }]

      await expect(assertions.assertCount('users', 2)).resolves.toBeUndefined()
    })

    it('fails for wrong count', async () => {
      mockDb.data = [{ id: 1 }]

      await expect(assertions.assertCount('users', 2)).rejects.toThrow()
    })
  })

  describe('assertEmpty', () => {
    it('passes when table is empty', async () => {
      mockDb.data = []

      await expect(assertions.assertEmpty('users')).resolves.toBeUndefined()
    })

    it('fails when table has records', async () => {
      mockDb.data = [{ id: 1 }]

      await expect(assertions.assertEmpty('users')).rejects.toThrow()
    })
  })
})

// Test event classes
class UserRegistered extends Event {
  static override eventName = 'UserRegistered'

  constructor(
    public readonly userId: string,
    public readonly email: string
  ) {
    super()
  }
}

class OrderCreated extends Event {
  static override eventName = 'OrderCreated'

  constructor(public readonly orderId: number) {
    super()
  }
}

class PaymentProcessed extends Event {
  static override eventName = 'PaymentProcessed'

  constructor(public readonly amount: number) {
    super()
  }
}

describe('FakeEvent', () => {
  let events: FakeEvent

  beforeEach(() => {
    events = fakeEvent()
  })

  describe('recording', () => {
    it('records dispatched events', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(events.all()).toHaveLength(1)
    })

    it('records multiple events', () => {
      events.record(new UserRegistered('123', 'test@example.com'))
      events.record(new OrderCreated(456))

      expect(events.all()).toHaveLength(2)
    })
  })

  describe('assertDispatched', () => {
    it('passes when event was dispatched', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() => events.assertDispatched(UserRegistered)).not.toThrow()
    })

    it('fails when event was not dispatched', () => {
      expect(() => events.assertDispatched(UserRegistered)).toThrow(
        'Expected event [UserRegistered] to be dispatched'
      )
    })

    it('passes with callback when event matches', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatched(UserRegistered, (e: UserRegistered) => e.userId === '123')
      ).not.toThrow()
    })

    it('fails with callback when no event matches', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatched(UserRegistered, (e: UserRegistered) => e.userId === '456')
      ).toThrow('Expected event [UserRegistered] to match callback')
    })
  })

  describe('assertDispatchedTimes', () => {
    it('passes for correct count', () => {
      events.record(new UserRegistered('1', 'a@example.com'))
      events.record(new UserRegistered('2', 'b@example.com'))

      expect(() => events.assertDispatchedTimes(UserRegistered, 2)).not.toThrow()
    })

    it('fails for wrong count', () => {
      events.record(new UserRegistered('1', 'test@example.com'))

      expect(() => events.assertDispatchedTimes(UserRegistered, 2)).toThrow(
        'Expected event [UserRegistered] to be dispatched 2 times, got 1'
      )
    })
  })

  describe('assertNotDispatched', () => {
    it('passes when event was not dispatched', () => {
      expect(() => events.assertNotDispatched(UserRegistered)).not.toThrow()
    })

    it('fails when event was dispatched', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() => events.assertNotDispatched(UserRegistered)).toThrow(
        'Expected event [UserRegistered] not to be dispatched'
      )
    })
  })

  describe('assertNothingDispatched', () => {
    it('passes when no events were dispatched', () => {
      expect(() => events.assertNothingDispatched()).not.toThrow()
    })

    it('fails when events were dispatched', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() => events.assertNothingDispatched()).toThrow(
        'Expected no events to be dispatched'
      )
    })
  })

  describe('assertDispatchedInOrder', () => {
    it('passes when events are in correct order', () => {
      events.record(new UserRegistered('123', 'test@example.com'))
      events.record(new OrderCreated(456))
      events.record(new PaymentProcessed(100))

      expect(() =>
        events.assertDispatchedInOrder([
          UserRegistered,
          OrderCreated,
          PaymentProcessed,
        ])
      ).not.toThrow()
    })

    it('passes when events are in order with other events in between', () => {
      events.record(new UserRegistered('123', 'test@example.com'))
      events.record(new PaymentProcessed(50))
      events.record(new OrderCreated(456))

      expect(() =>
        events.assertDispatchedInOrder([
          UserRegistered,
          OrderCreated,
        ])
      ).not.toThrow()
    })

    it('fails when events are out of order', () => {
      events.record(new OrderCreated(456))
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatchedInOrder([
          UserRegistered,
          OrderCreated,
        ])
      ).toThrow('Expected event [OrderCreated] to be dispatched in order')
    })

    it('fails when not enough events', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatchedInOrder([
          UserRegistered,
          OrderCreated,
        ])
      ).toThrow('Expected 2 events in order')
    })
  })

  describe('assertDispatchedWith', () => {
    it('passes when event matches data', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatchedWith(UserRegistered, {
          userId: '123',
          email: 'test@example.com',
        })
      ).not.toThrow()
    })

    it('passes with partial data match', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatchedWith(UserRegistered, { userId: '123' })
      ).not.toThrow()
    })

    it('fails when data does not match', () => {
      events.record(new UserRegistered('123', 'test@example.com'))

      expect(() =>
        events.assertDispatchedWith(UserRegistered, { userId: '456' })
      ).toThrow('Expected event [UserRegistered] to be dispatched with matching data')
    })

    it('fails when event was not dispatched', () => {
      expect(() =>
        events.assertDispatchedWith(UserRegistered, { userId: '123' })
      ).toThrow('Expected event [UserRegistered] to be dispatched')
    })
  })

  describe('querying', () => {
    it('dispatched returns events of specific type', () => {
      events.record(new UserRegistered('123', 'test@example.com'))
      events.record(new OrderCreated(456))

      const userEvents = events.dispatched(UserRegistered)
      expect(userEvents).toHaveLength(1)
      expect((userEvents[0].event as UserRegistered).userId).toBe('123')
    })

    it('all returns all dispatched events', () => {
      events.record(new UserRegistered('123', 'test@example.com'))
      events.record(new OrderCreated(456))

      expect(events.all()).toHaveLength(2)
    })

    it('clear removes all events', () => {
      events.record(new UserRegistered('123', 'test@example.com'))
      events.clear()

      expect(events.all()).toHaveLength(0)
    })
  })

  describe('FakeEventManager', () => {
    it('can be used as drop-in replacement for EventManager', async () => {
      const manager = events.getManager()

      // Register listeners
      let received: UserRegistered | null = null
      manager.on(UserRegistered, (e) => {
        received = e as UserRegistered
      })

      // Emit event (fake manager only records, doesn't call listeners)
      await manager.emit(new UserRegistered('123', 'test@example.com'))

      // Event should be recorded
      const recorded = manager.getEventsOf(UserRegistered)
      expect(recorded).toHaveLength(1)
    })

    it('tracks listeners', () => {
      const manager = events.getManager()

      manager.on(UserRegistered, () => {})
      manager.on(UserRegistered, () => {})

      expect(manager.hasListeners(UserRegistered)).toBe(true)
      expect(manager.listenerCount(UserRegistered)).toBe(2)
    })

    it('can remove listeners', () => {
      const manager = events.getManager()

      const listener = () => {}
      manager.on(UserRegistered, listener)
      manager.off(UserRegistered, listener)

      expect(manager.hasListeners(UserRegistered)).toBe(false)
    })

    it('can get event names', () => {
      const manager = events.getManager()

      manager.on(UserRegistered, () => {})
      manager.on(OrderCreated, () => {})

      const names = manager.eventNames()
      expect(names).toContain('UserRegistered')
      expect(names).toContain('OrderCreated')
    })

    it('removeAllListeners clears all', () => {
      const manager = events.getManager()

      manager.on(UserRegistered, () => {})
      manager.on(OrderCreated, () => {})
      manager.removeAllListeners()

      expect(manager.eventNames()).toHaveLength(0)
    })
  })
})
