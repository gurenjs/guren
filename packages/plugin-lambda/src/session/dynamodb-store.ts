import type { SessionData, SessionStore } from '@guren/server'

/**
 * Sessions in DynamoDB, for Lambda apps that want session churn off the
 * primary database (RFC 0020 §4). Items are `{ id, data, expires_at }`; the
 * table's TTL attribute is `expires_at`, in epoch seconds.
 * `@aws-sdk/client-dynamodb` is an optional peer, imported on first use.
 */

interface DynamoDbClient {
  send(command: unknown): Promise<unknown>
}

interface AttributeValue {
  S?: string
  N?: string
}

export interface DynamoDbSessionStoreOptions {
  /** Table name. `guren lambda:build` apps read it from DYNAMODB_SESSIONS_TABLE. */
  table: string
  /** Defaults to AWS_REGION, which Lambda always sets. */
  region?: string
  /** For DynamoDB Local, or a VPC endpoint. */
  endpoint?: string
  /** A pre-built client. Skips both the lazy import and the credential chain. */
  client?: DynamoDbClient
  now?: () => number
}

export class DynamoDbSessionStore implements SessionStore {
  private client: DynamoDbClient | null
  private readonly table: string
  private readonly region?: string
  private readonly endpoint?: string
  private readonly now: () => number

  constructor(options: DynamoDbSessionStoreOptions) {
    this.client = options.client ?? null
    this.table = options.table
    this.region = options.region
    this.endpoint = options.endpoint
    this.now = options.now ?? (() => Date.now())
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000)
  }

  private async getClient(): Promise<DynamoDbClient> {
    if (this.client) {
      return this.client
    }

    const { DynamoDBClient } = await importDynamoDb() as {
      DynamoDBClient: new (config: unknown) => DynamoDbClient
    }

    const config: Record<string, unknown> = {}
    if (this.region) config.region = this.region
    if (this.endpoint) config.endpoint = this.endpoint

    this.client = new DynamoDBClient(config)
    return this.client
  }

  async read(id: string): Promise<SessionData | undefined> {
    const { GetItemCommand } = await importDynamoDb() as {
      GetItemCommand: new (input: unknown) => unknown
    }
    const client = await this.getClient()

    // Strongly consistent, not DynamoDB's eventually consistent default: a
    // session written at login must be readable on the redirect that follows,
    // which is the same guarantee that rules KV out entirely (RFC 0020 §4).
    const result = await client.send(new GetItemCommand({
      TableName: this.table,
      Key: { id: { S: id } },
      ConsistentRead: true,
    })) as { Item?: Record<string, AttributeValue> }

    const item = result.Item
    if (!item) {
      return undefined
    }

    // TTL deletes lazily, within 48 hours of expiry, so an item that is still
    // present may already be expired. The store, not the table, is what makes
    // a session stop existing on time.
    const expiresAt = Number(item.expires_at?.N ?? '0')
    if (!Number.isFinite(expiresAt) || expiresAt <= this.nowSeconds()) {
      return undefined
    }

    return parseSessionData(item.data?.S)
  }

  async write(id: string, data: SessionData, ttlSeconds: number): Promise<void> {
    const { PutItemCommand } = await importDynamoDb() as {
      PutItemCommand: new (input: unknown) => unknown
    }
    const client = await this.getClient()

    await client.send(new PutItemCommand({
      TableName: this.table,
      Item: {
        id: { S: id },
        data: { S: JSON.stringify(data) },
        expires_at: { N: String(this.nowSeconds() + ttlSeconds) },
      },
    }))
  }

  async destroy(id: string): Promise<void> {
    const { DeleteItemCommand } = await importDynamoDb() as {
      DeleteItemCommand: new (input: unknown) => unknown
    }
    const client = await this.getClient()

    await client.send(new DeleteItemCommand({
      TableName: this.table,
      Key: { id: { S: id } },
    }))
  }

  async touch(id: string, ttlSeconds: number): Promise<void> {
    const { UpdateItemCommand } = await importDynamoDb() as {
      UpdateItemCommand: new (input: unknown) => unknown
    }
    const client = await this.getClient()
    const now = this.nowSeconds()

    try {
      // The condition is the contract: a bare UpdateItem *creates* the item,
      // so without it refreshing a destroyed session would resurrect it empty
      // (SessionStore.touch forbids exactly that).
      // `id` and `expires_at` need no alias — neither is in DynamoDB's
      // reserved-word list, which does contain `DATA`; keep `data` out of one.
      await client.send(new UpdateItemCommand({
        TableName: this.table,
        Key: { id: { S: id } },
        UpdateExpression: 'SET expires_at = :expires',
        ConditionExpression: 'attribute_exists(id) AND expires_at > :now',
        ExpressionAttributeValues: {
          ':expires': { N: String(now + ttlSeconds) },
          ':now': { N: String(now) },
        },
      }))
    } catch (error) {
      // The condition failing *is* the no-op case, not an error to report.
      if (!isConditionalCheckFailed(error)) throw error
    }
  }
}

function parseSessionData(raw: string | undefined): SessionData | undefined {
  if (raw === undefined) return undefined

  try {
    const parsed = JSON.parse(raw) as unknown
    // A non-object decodes without throwing, and would reach the app as a
    // session whose every property read is undefined.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as SessionData
  } catch {
    return undefined
  }
}

function isConditionalCheckFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = (error as { name?: string }).name
  return name === 'ConditionalCheckFailedException'
}

function isMissingModule(error: unknown, moduleName: string): boolean {
  if (!error || typeof error !== 'object') return false
  if ((error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND') return true
  const message = String((error as { message?: string }).message ?? '')
  return (
    message.includes(`Cannot find package '${moduleName}'`) ||
    message.includes(`Cannot find module '${moduleName}'`)
  )
}

async function importDynamoDb(): Promise<unknown> {
  const moduleName = '@aws-sdk/client-dynamodb'

  try {
    return await import(moduleName)
  } catch (error) {
    if (isMissingModule(error, moduleName)) {
      throw new Error(
        `Missing optional dependency "${moduleName}". Install it to use the dynamodb session driver.`,
      )
    }
    throw error
  }
}
