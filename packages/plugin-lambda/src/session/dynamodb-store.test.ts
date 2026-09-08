import { describe, expect, it, mock } from 'bun:test'

// The AWS SDK is an optional peer not installed in this workspace, and the
// store only needs the command classes as carriers for their input. bun never
// restores mock.module, so this replacement outlives this file; the only
// behavior it can mask elsewhere is the missing-optional-dependency error.
await mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    constructor(readonly config: Record<string, unknown>) {}
    async send(): Promise<unknown> { return {} }
  },
  GetItemCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  PutItemCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteItemCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  UpdateItemCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}))

const { DynamoDbSessionStore, registerDynamoDbSessionDriver } = await import('./index')
const { SessionManager } = await import('@guren/server')

const NOW_MS = 1_800_000_000_000
const NOW_SECONDS = 1_800_000_000

class FakeClient {
  readonly inputs: Array<Record<string, unknown>> = []

  constructor(private readonly responses: unknown[] = [{}]) {}

  async send(command: unknown): Promise<unknown> {
    this.inputs.push((command as { input: Record<string, unknown> }).input)
    const next = this.responses.shift()
    if (next instanceof Error) throw next
    return next ?? {}
  }
}

function storeWith(responses: unknown[] = [{}]): { store: InstanceType<typeof DynamoDbSessionStore>; client: FakeClient } {
  const client = new FakeClient(responses)
  const store = new DynamoDbSessionStore({ table: 'sessions', client, now: () => NOW_MS })
  return { store, client }
}

function item(data: string, expiresAt: number): Record<string, unknown> {
  return { Item: { id: { S: 'abc' }, data: { S: data }, expires_at: { N: String(expiresAt) } } }
}

describe('DynamoDbSessionStore', () => {
  describe('read', () => {
    it('returns undefined when the item does not exist', async () => {
      const { store } = storeWith([{}])
      expect(await store.read('abc')).toBeUndefined()
    })

    it('reads strongly consistently, so a login is visible on the redirect after it', async () => {
      const { store, client } = storeWith([item('{"userId":7}', NOW_SECONDS + 60)])

      await store.read('abc')

      expect(client.inputs[0]).toEqual({
        TableName: 'sessions',
        Key: { id: { S: 'abc' } },
        ConsistentRead: true,
      })
    })

    it('returns the stored data', async () => {
      const { store } = storeWith([item('{"userId":7}', NOW_SECONDS + 60)])
      expect(await store.read('abc')).toEqual({ userId: 7 })
    })

    it('treats an item TTL has not deleted yet as missing', async () => {
      // DynamoDB deletes within 48 hours of expiry, not at it.
      const { store } = storeWith([item('{"userId":7}', NOW_SECONDS - 1)])
      expect(await store.read('abc')).toBeUndefined()
    })

    it('treats an item expiring exactly now as missing', async () => {
      const { store } = storeWith([item('{"userId":7}', NOW_SECONDS)])
      expect(await store.read('abc')).toBeUndefined()
    })

    it('returns undefined for data that is not a JSON object', async () => {
      const { store } = storeWith([item('"a string"', NOW_SECONDS + 60)])
      expect(await store.read('abc')).toBeUndefined()
    })

    it('returns undefined for unparseable data rather than throwing', async () => {
      const { store } = storeWith([item('{not json', NOW_SECONDS + 60)])
      expect(await store.read('abc')).toBeUndefined()
    })

    it('treats an item with no expires_at as expired', async () => {
      const { store } = storeWith([{ Item: { id: { S: 'abc' }, data: { S: '{}' } } }])
      expect(await store.read('abc')).toBeUndefined()
    })
  })

  describe('write', () => {
    it('stores the data and an epoch-seconds expiry', async () => {
      const { store, client } = storeWith()

      await store.write('abc', { userId: 7 }, 120)

      expect(client.inputs[0]).toEqual({
        TableName: 'sessions',
        Item: {
          id: { S: 'abc' },
          data: { S: '{"userId":7}' },
          expires_at: { N: String(NOW_SECONDS + 120) },
        },
      })
    })
  })

  describe('destroy', () => {
    it('deletes the item', async () => {
      const { store, client } = storeWith()

      await store.destroy('abc')

      expect(client.inputs[0]).toEqual({ TableName: 'sessions', Key: { id: { S: 'abc' } } })
    })
  })

  describe('touch', () => {
    it('refreshes the expiry only for a session that exists and has not expired', async () => {
      const { store, client } = storeWith()

      await store.touch('abc', 300)

      expect(client.inputs[0]).toEqual({
        TableName: 'sessions',
        Key: { id: { S: 'abc' } },
        UpdateExpression: 'SET expires_at = :expires',
        ConditionExpression: 'attribute_exists(id) AND expires_at > :now',
        ExpressionAttributeValues: {
          ':expires': { N: String(NOW_SECONDS + 300) },
          ':now': { N: String(NOW_SECONDS) },
        },
      })
    })

    it('is a no-op when the condition fails, not a resurrection', async () => {
      const failure = Object.assign(new Error('The conditional request failed'), {
        name: 'ConditionalCheckFailedException',
      })
      const { store } = storeWith([failure])

      expect(await store.touch('abc', 300)).toBeUndefined()
    })

    it('propagates any other failure', async () => {
      const { store } = storeWith([Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' })])

      await expect(store.touch('abc', 300)).rejects.toThrow('throttled')
    })
  })

  describe('client construction', () => {
    it('passes region and endpoint through, and omits what was not set', async () => {
      const store = new DynamoDbSessionStore({ table: 'sessions', region: 'ap-northeast-1' })

      await store.read('abc')

      const client = (store as unknown as { client: { config: Record<string, unknown> } }).client
      expect(client.config).toEqual({ region: 'ap-northeast-1' })
    })
  })
})

describe('registerDynamoDbSessionDriver', () => {
  it('resolves a store from the table in the config', async () => {
    const manager = new SessionManager({
      default: 'dynamodb',
      stores: { dynamodb: { driver: 'dynamodb', table: 'app-sessions' } },
    })
    registerDynamoDbSessionDriver(manager)

    const store = manager.store()

    expect(store).toBeInstanceOf(DynamoDbSessionStore)
    expect((store as unknown as { table: string }).table).toBe('app-sessions')
  })

  it('falls back to DYNAMODB_SESSIONS_TABLE, which the CDK construct sets', () => {
    const original = process.env.DYNAMODB_SESSIONS_TABLE
    process.env.DYNAMODB_SESSIONS_TABLE = 'from-env'

    try {
      const manager = new SessionManager({ default: 'dynamodb', stores: { dynamodb: { driver: 'dynamodb' } } })
      registerDynamoDbSessionDriver(manager)

      expect((manager.store() as unknown as { table: string }).table).toBe('from-env')
    } finally {
      if (original === undefined) delete process.env.DYNAMODB_SESSIONS_TABLE
      else process.env.DYNAMODB_SESSIONS_TABLE = original
    }
  })

  it('names the two ways to supply a table when neither is set', () => {
    const original = process.env.DYNAMODB_SESSIONS_TABLE
    delete process.env.DYNAMODB_SESSIONS_TABLE

    try {
      const manager = new SessionManager({ default: 'dynamodb', stores: { dynamodb: { driver: 'dynamodb' } } })
      registerDynamoDbSessionDriver(manager)

      expect(() => manager.store()).toThrow('DYNAMODB_SESSIONS_TABLE')
    } finally {
      if (original !== undefined) process.env.DYNAMODB_SESSIONS_TABLE = original
    }
  })
})
