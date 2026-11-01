import { describe, expect, it } from 'bun:test'
import { createApp, createExceptionHandler, ExceptionHandler, FailedJobReporter, renderDebugPage, ServiceProvider } from '../../src'
import { redactQueryParams, redactedMessage } from '../../src/errors/redact-query-params'
import { HealthCheck, HealthManager, type CheckResult } from '../../src/health'
import { clearJobRegistry, Job, registerJob, SyncDriver, type QueuedJob } from '../../src/queue'
import { Scheduler } from '../../src/scheduling'

// Joined at runtime: Bun prints the source lines around a throw site when it
// inspects an error, and a literal here would show up in that snippet.
const HASH = ['scrypt', '16384', 'c2VjcmV0LWhhc2g'].join('$')
const EMAIL = ['ada', 'example.com'].join('@')
const SQL = 'insert into "users" ("email", "password_hash") values ($1, $2) returning "id"'

/** Mirrors drizzle-orm's DrizzleQueryError (drizzle-orm/errors.js) without importing it. */
class DrizzleQueryError extends Error {
  query: string
  params: unknown[]
  constructor(query: string, params: unknown[], cause?: unknown) {
    super(`Failed query: ${query}\nparams: ${params}`)
    this.query = query
    this.params = params
    this.cause = cause
    this.name = 'DrizzleQueryError'
    Error.captureStackTrace(this, DrizzleQueryError)
  }
}

/** The postgres.js shape: `query`/`parameters`/`args`, enumerable under its `debug` option. */
function driverError(): Error {
  const error = new Error('duplicate key value violates unique constraint "users_email_unique"')
  Object.defineProperties(error, {
    query: { value: SQL, enumerable: true },
    parameters: { value: [EMAIL, HASH], enumerable: true },
    args: { value: [EMAIL, HASH], enumerable: true },
  })
  return error
}

function failedInsert(params: unknown[] = [EMAIL, HASH], sql = SQL): DrizzleQueryError {
  return new DrizzleQueryError(sql, params, driverError())
}

function captureConsoleError() {
  const calls: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    calls.push(args)
  }
  return {
    calls,
    printed: () => calls.map((args) => args.map((arg) => typeof arg === 'string' ? arg : Bun.inspect(arg)).join(' ')).join('\n'),
    restore: () => {
      console.error = original
    },
  }
}

describe('redactQueryParams', () => {
  it('replaces the params in the message, the stack and the params property', () => {
    const redacted = redactQueryParams(failedInsert())

    expect(redacted.message).toBe(`Failed query: ${SQL}\nparams: [redacted 2 values]`)
    expect(redacted.stack).toStartWith(`DrizzleQueryError: Failed query: ${SQL}\nparams: [redacted 2 values]\n`)
    expect(redacted.stack).toContain('    at ')
    expect(redacted.params as unknown).toBe('[redacted 2 values]')
    expect(redacted.query).toBe(SQL)
    expect(Bun.inspect(redacted)).not.toContain(HASH)
  })

  it('keeps the class, name and cause chain, and leaves the original untouched', () => {
    const original = failedInsert()
    const redacted = redactQueryParams(original)

    expect(redacted).not.toBe(original)
    expect(redacted).toBeInstanceOf(DrizzleQueryError)
    expect(redacted.name).toBe('DrizzleQueryError')
    expect(original.params).toEqual([EMAIL, HASH])

    const cause = redacted.cause as Record<string, unknown> & Error
    expect(cause.message).toContain('users_email_unique')
    expect(cause.parameters).toBe('[redacted 2 values]')
    expect(cause.args).toBe('[redacted 2 values]')
    expect(Bun.inspect(cause)).not.toContain(HASH)
  })

  it('cuts a param holding a newline, the separator or frame-like text', () => {
    const tricky = `${HASH}\nparams: x\n    at fake (/tmp/x.ts:1:1)`
    const redacted = redactQueryParams(failedInsert([EMAIL, tricky]))

    expect(redacted.message).toBe(`Failed query: ${SQL}\nparams: [redacted 2 values]`)
    expect(redacted.stack).not.toContain(HASH)
    expect(redacted.stack).not.toContain('fake (/tmp/x.ts')
  })

  it('keeps `$` sequences in the SQL verbatim', () => {
    const sql = 'select $$a$$, $1, $` as "x" from "users" where "email" = $2'
    const redacted = redactQueryParams(failedInsert([EMAIL, HASH], sql))

    expect(redacted.message).toBe(`Failed query: ${sql}\nparams: [redacted 2 values]`)
    expect(redacted.stack).toStartWith(`DrizzleQueryError: Failed query: ${sql}\nparams: [redacted 2 values]\n`)
  })

  it('returns the same error when nothing carries params, and is idempotent', () => {
    const plain = new Error('disk full')
    expect(redactQueryParams(plain)).toBe(plain)

    const once = redactQueryParams(failedInsert())
    expect(redactQueryParams(once)).toBe(once)
  })

  it('redacts a message that only carries the text shape, and a wrapping message', () => {
    const textOnly = new Error(`Failed query: ${SQL}\nparams: ${EMAIL},${HASH}`)
    const wrapped = new Error(`Registration failed: Failed query: ${SQL}\nparams: ${EMAIL},${HASH}`, {
      cause: failedInsert(),
    })

    expect(redactQueryParams(textOnly).message).toBe(`Failed query: ${SQL}\nparams: [redacted]`)
    const redacted = redactQueryParams(wrapped)
    expect(redacted.message).toBe(`Registration failed: Failed query: ${SQL}\nparams: [redacted]`)
    expect(Bun.inspect(redacted)).not.toContain(HASH)
    expect(Bun.inspect(redacted)).toContain('[redacted 2 values]')
  })

  it('redacts the statement mysql2 formats the values into', () => {
    const mysqlError = Object.assign(new Error(`Duplicate entry for key 'users.users_email_unique'`), {
      code: 'ER_DUP_ENTRY',
      sqlState: '23000',
      sql: `insert into \`users\` (\`email\`, \`password_hash\`) values ('${EMAIL}', '${HASH}')`,
    })
    const redacted = redactQueryParams(new DrizzleQueryError('insert into `users` (`email`, `password_hash`) values (?, ?)', [EMAIL, HASH], mysqlError))

    const cause = redacted.cause as Record<string, unknown>
    expect(cause.sql).toBe('[redacted]')
    expect(cause.code).toBe('ER_DUP_ENTRY')
    expect(Bun.inspect(redacted)).not.toContain(HASH)
  })

  it('keeps non-enumerable own properties such as statusCode', () => {
    class RegistrationFailed extends Error {
      constructor(cause: Error) {
        super('Could not register', { cause })
        Object.defineProperty(this, 'statusCode', { value: 409, enumerable: false })
      }
    }
    const redacted = redactQueryParams(new RegistrationFailed(failedInsert()))

    expect(redacted).toBeInstanceOf(RegistrationFailed)
    expect(Object.getOwnPropertyDescriptor(redacted, 'statusCode')).toMatchObject({ value: 409, enumerable: false })
    expect(Bun.inspect(redacted)).not.toContain(HASH)
  })

  it('survives a cyclic cause', () => {
    const error = failedInsert()
    ;(error.cause as Error).cause = error

    const redacted = redactQueryParams(error)
    expect((redacted.cause as Error).cause).toBe(redacted)
    expect(redactedMessage(error)).toBe(`Failed query: ${SQL}\nparams: [redacted 2 values]`)
  })
})

describe('ExceptionHandler with a failed query', () => {
  async function appWithDebug(debug: boolean) {
    class DebugProvider extends ServiceProvider {
      register(): void {
        this.container.instance('exception.handler', createExceptionHandler({ debug }))
      }
    }
    const app = createApp({
      routes: (router) => {
        router.get('/register', () => {
          throw failedInsert()
        })
      },
      providers: [DebugProvider],
    })
    await app.boot()
    return app
  }

  it('keeps the params out of the debug JSON body', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(new Request('http://example.com/register', { headers: { Accept: 'application/json' } }))
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(text).not.toContain(HASH)
    const body = JSON.parse(text) as { message: string; exception: string; stack: string }
    expect(body.message).toBe(`Failed query: ${SQL}\nparams: [redacted 2 values]`)
    expect(body.exception).toBe('DrizzleQueryError')
    expect(body.stack).toContain('[redacted 2 values]')
  })

  it('keeps the params out of the debug page', async () => {
    const app = await appWithDebug(true)

    const response = await app.fetch(new Request('http://example.com/register', { headers: { Accept: 'text/html' } }))
    const html = await response.text()

    expect(response.status).toBe(500)
    expect(html).toContain('Debug Error Page')
    expect(html).toContain('[redacted 2 values]')
    expect(html).toContain('password_hash')
    expect(html).not.toContain(HASH)
  })

  it('keeps the params out of the page renderDebugPage writes directly', () => {
    const html = renderDebugPage(failedInsert())

    expect(html).toContain('[redacted 2 values]')
    expect(html).not.toContain(HASH)
  })

  it('keeps the params out of the fallback log', async () => {
    const handler = new ExceptionHandler({ debug: false })
    const ctx = { json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }) }
    const captured = captureConsoleError()
    try {
      await handler.handle(failedInsert(), ctx as never)
    } finally {
      captured.restore()
    }

    expect(captured.calls).toHaveLength(1)
    expect(captured.calls[0]?.[0]).toBe('Unhandled exception:')
    const printed = captured.printed()
    expect(printed).toContain('[redacted 2 values]')
    expect(printed).toContain('password_hash')
    expect(printed).not.toContain(HASH)
  })

  it('hands registered reporters the redacted error', async () => {
    const handler = new ExceptionHandler({ debug: false })
    const reported: Error[] = []
    handler.report((error) => {
      reported.push(error)
    })
    const ctx = { json: (body: unknown, status?: number) => new Response(JSON.stringify(body), { status }) }

    await handler.handle(failedInsert(), ctx as never)

    expect(reported).toHaveLength(1)
    expect(reported[0]).toBeInstanceOf(DrizzleQueryError)
    expect(Bun.inspect(reported[0])).not.toContain(HASH)
  })
})

describe('FailedJobReporter default log', () => {
  it('keeps the params out of the job failure line', async () => {
    const captured = captureConsoleError()
    try {
      await new FailedJobReporter().report({
        jobName: 'RegisterUser',
        queue: 'default',
        attempt: 3,
        maxAttempts: 3,
        willRetry: false,
        error: failedInsert(),
        failedAt: new Date(0),
      })
    } finally {
      captured.restore()
    }

    const printed = captured.printed()
    expect(printed).toContain('[redacted 2 values]')
    expect(printed).not.toContain(HASH)
  })
})

describe('other failure sinks', () => {
  it('stores a sync-driver job failure without the params', async () => {
    class RegisterUserJob extends Job<Record<string, never>> {
      async handle(): Promise<void> {
        throw failedInsert()
      }
    }
    registerJob(RegisterUserJob)
    const driver = new SyncDriver()
    const job: QueuedJob = {
      id: 'job-1', name: 'RegisterUserJob', payload: {}, queue: 'default',
      attempts: 0, maxAttempts: 1, availableAt: new Date(), createdAt: new Date(), reservedAt: null,
    }
    try {
      await expect(driver.push(job)).rejects.toThrow('Failed query')
    } finally {
      clearJobRegistry()
    }

    const [failed] = await driver.getFailedJobs()
    expect(failed?.error).toBe(`Failed query: ${SQL}\nparams: [redacted 2 values]`)
    expect(failed?.stack).toContain('[redacted 2 values]')
    expect(failed?.stack).not.toContain(HASH)
  })

  it('keeps the params out of the scheduler log', async () => {
    const logged: string[] = []
    const scheduler = new Scheduler({ logger: (message) => logged.push(message) })
    scheduler.schedule((schedule) => {
      schedule.call(async () => {
        throw failedInsert()
      }).everyMinute().name('import-users')
    })

    await scheduler.runDueTasks(new Date())

    expect(logged).toContain(`Task failed: import-users - Failed query: ${SQL}\nparams: [redacted 2 values]`)
    expect(logged.join('\n')).not.toContain(HASH)
  })

  it('keeps the params out of the /health report', async () => {
    class DatabaseCheck extends HealthCheck {
      readonly name = 'database'
      async check(): Promise<CheckResult> {
        throw failedInsert()
      }
    }

    const report = JSON.stringify(await new HealthManager().register(new DatabaseCheck()).check())

    expect(report).toContain('[redacted 2 values]')
    expect(report).not.toContain(HASH)
  })
})
