import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { createAwsDataApiDatabase, type AwsDataApiDatabaseOptions } from '../src/aws-data-api'
import type { ConnectionContext } from '../src/connection-context'
import { createResumeRetry, isDatabaseResuming } from '../src/aws-data-api-resume'

interface Reply {
  statusCode: number
  headers: Record<string, string>
  body: Uint8Array
}

function reply(statusCode: number, body: unknown, errorType?: string): () => Reply {
  return () => ({
    statusCode,
    headers: { 'content-type': 'application/json', ...(errorType ? { 'x-amzn-errortype': errorType } : {}) },
    body: new TextEncoder().encode(JSON.stringify(body)),
  })
}

const resuming = reply(400, { message: 'The Aurora DB instance is resuming after being auto-paused.' }, 'DatabaseResumingException')
const statementTimeout = reply(400, { message: 'Request timed out' }, 'StatementTimeoutException')
const oneRow = reply(200, { records: [[{ longValue: 1 }]], columnMetadata: [{ name: 'one' }], numberOfRecordsUpdated: 0 })

// Stands in for the HTTP layer only: the real RDSDataClient and the real drizzle
// driver run above it. The last reply repeats once the list is used up.
function requestHandler(replies: Array<() => Reply>) {
  const paths: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  return {
    paths,
    bodies,
    handle: async (request: { path: string; body: string }) => {
      paths.push(request.path)
      bodies.push(JSON.parse(request.body) as Record<string, unknown>)
      const next = replies.length > 1 ? replies.shift()! : replies[0]!
      return { response: next() }
    },
    updateHttpClientConfig() {},
    httpHandlerConfigs: () => ({}),
    destroy() {},
  }
}

function emptyFolder(): string {
  return mkdtempSync(join(tmpdir(), 'guren-orm-resume-'))
}

function database(handler: ReturnType<typeof requestHandler>, options: Partial<AwsDataApiDatabaseOptions> = {}) {
  return createAwsDataApiDatabase({
    migrationsFolder: emptyFolder(),
    database: 'appdb',
    resourceArn: 'arn:aws:rds:ap-northeast-1:123456789012:cluster:example',
    secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:example',
    clientOptions: {
      region: 'ap-northeast-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestHandler: handler as never,
    },
    resumeRetry: { maxDelayMs: 1 },
    ...options,
  })
}

async function causeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return (error as { cause?: unknown }).cause ?? error
  }
  throw new Error('expected the call to reject')
}

describe('createAwsDataApiDatabase resumeRetry', () => {
  let warn: ReturnType<typeof spyOn>

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  test('should retry a statement until the paused cluster answers', async () => {
    const handler = requestHandler([resuming, resuming, oneRow])
    const db = await database(handler).getDatabase()

    const result = (await db.execute(sql`select 1 as one`)) as unknown as { rows: unknown[] }

    expect(result.rows).toEqual([{ one: 1 }])
    expect(handler.paths).toEqual(['/Execute', '/Execute', '/Execute'])
  })

  test('should say once that the cluster is resuming', async () => {
    const handler = requestHandler([resuming, resuming, oneRow])
    const db = await database(handler).getDatabase()

    await db.execute(sql`select 1 as one`)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('resuming from a pause')
  })

  test('should retry the call that opens a transaction', async () => {
    const handler = requestHandler([resuming, oneRow])
    const db = await database(handler).getDatabase()

    await db.transaction(async (tx) => {
      await tx.execute(sql`select 1 as one`)
    })

    expect(handler.paths).toEqual(['/BeginTransaction', '/BeginTransaction', '/Execute', '/CommitTransaction'])
  })

  test('should retry on the handle migrationStatus() opens', async () => {
    const migrationsFolder = emptyFolder()
    mkdirSync(join(migrationsFolder, '20240101000000_init'))
    writeFileSync(join(migrationsFolder, '20240101000000_init', 'migration.sql'), 'select 1;')
    const handler = requestHandler([resuming, reply(200, { records: [], columnMetadata: [{ name: 'name' }] })])

    const status = await database(handler, { migrationsFolder }).migrationStatus()

    expect(status.map((entry) => entry.applied)).toEqual([false])
    expect(handler.paths).toEqual(['/Execute', '/Execute'])
  })

  test('should rethrow the resuming error once the timeout has passed', async () => {
    const handler = requestHandler([resuming])
    const db = await database(handler, { resumeRetry: { timeoutMs: 30, maxDelayMs: 1 } }).getDatabase()

    const cause = await causeOf(db.execute(sql`select 1`))

    expect(isDatabaseResuming(cause)).toBe(true)
    expect(handler.paths.length).toBeGreaterThan(1)
  })

  test('should not retry when resumeRetry is false', async () => {
    const handler = requestHandler([resuming, oneRow])
    const db = await database(handler, { resumeRetry: false }).getDatabase()

    const cause = await causeOf(db.execute(sql`select 1`))

    expect(isDatabaseResuming(cause)).toBe(true)
    expect(handler.paths).toEqual(['/Execute'])
    expect(warn).not.toHaveBeenCalled()
  })

  test('should not retry when timeoutMs is 0', async () => {
    const handler = requestHandler([resuming, oneRow])
    const db = await database(handler, { resumeRetry: { timeoutMs: 0 } }).getDatabase()

    const cause = await causeOf(db.execute(sql`select 1`))

    expect(isDatabaseResuming(cause)).toBe(true)
    expect(handler.paths).toEqual(['/Execute'])
  })

  test('should warn once when two handles meet the same pause', async () => {
    const migrationsFolder = emptyFolder()
    mkdirSync(join(migrationsFolder, '20240101000000_init'))
    writeFileSync(join(migrationsFolder, '20240101000000_init', 'migration.sql'), 'select 1;')
    const noRows = reply(200, { records: [], columnMetadata: [{ name: 'name' }] })
    const handler = requestHandler([resuming, resuming, noRows])
    const factory = database(handler, { migrationsFolder })

    await Promise.all([factory.migrationStatus(), factory.migrationStatus()])

    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('should refuse a timeout that is not a number when the factory is created', () => {
    expect(() => database(requestHandler([oneRow]), { resumeRetry: { timeoutMs: Number('not-a-number') } })).toThrow(
      'resumeRetry.timeoutMs must be a finite number of milliseconds, 0 or more (received NaN)',
    )
  })

  test('should refuse a delay of 0 when the factory is created', () => {
    expect(() => database(requestHandler([oneRow]), { resumeRetry: { maxDelayMs: 0 } })).toThrow(
      'resumeRetry.maxDelayMs must be a finite number of milliseconds, above 0 (received 0)',
    )
  })

  test('should use the context configureOrm() received while the handle was opening', async () => {
    const handler = requestHandler([oneRow])
    const factory = database(handler, {
      database: (context) => (context ? 'after' : 'before'),
    })

    const opening = factory.getDatabase()
    await factory.configureOrm({ env: {} } as ConnectionContext)
    await (await opening).execute(sql`select 1 as one`)

    expect(handler.bodies.map((body) => body.database)).toEqual(['after'])
  })

  test('should not retry a statement that timed out', async () => {
    const handler = requestHandler([statementTimeout, oneRow])
    const db = await database(handler).getDatabase()

    const cause = await causeOf(db.execute(sql`select 1`))

    expect((cause as Error).name).toBe('StatementTimeoutException')
    expect(handler.paths).toEqual(['/Execute'])
  })
})

describe('createResumeRetry', () => {
  let warn: ReturnType<typeof spyOn>

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  function resumingError(): Error {
    return Object.assign(new Error('resuming'), { name: 'DatabaseResumingException' })
  }

  test('should pass the command and options to every try', async () => {
    const calls: unknown[][] = []
    const client = {
      send: async (...args: unknown[]) => {
        calls.push(args)
        if (calls.length === 1) throw resumingError()
        return 'done'
      },
    }
    createResumeRetry({ maxDelayMs: 1 })(client)

    const result = await client.send('command', { requestTimeout: 5 })

    expect(result).toBe('done')
    expect(calls).toEqual([
      ['command', { requestTimeout: 5 }],
      ['command', { requestTimeout: 5 }],
    ])
  })

  test('should keep the client as the receiver of send', async () => {
    const client = {
      label: 'client',
      async send(this: { label: string }) {
        return this.label
      },
    }
    createResumeRetry()(client as never)

    expect(await (client.send as () => Promise<string>)()).toBe('client')
  })

  test('should leave the callback form to the client', () => {
    let tries = 0
    const client = {
      send: (..._args: unknown[]): unknown => {
        tries += 1
        return undefined
      },
    }
    createResumeRetry({ maxDelayMs: 1 })(client)

    expect(client.send('command', () => {})).toBeUndefined()
    expect(tries).toBe(1)
  })

  test('should announce a second pause after a call got through', async () => {
    const outcomes = ['resuming', 'ok', 'resuming', 'ok']
    const client = {
      send: async (..._args: unknown[]) => {
        if (outcomes.shift() === 'resuming') throw resumingError()
        return 'done'
      },
    }
    createResumeRetry({ maxDelayMs: 1 })(client)

    await client.send('first')
    await client.send('second')

    expect(warn).toHaveBeenCalledTimes(2)
  })

  test('should leave a client with no send untouched', () => {
    const client: { send?: (...args: unknown[]) => unknown } = {}

    createResumeRetry()(client)

    expect(client.send).toBeUndefined()
  })
})
