import { describe, expect, it, mock } from 'bun:test'

// The AWS SDK is an optional peer that is not installed in this workspace.
// The driver only needs the command classes as carriers for their input, so
// bare stand-ins are enough — the logic under test (following continuation
// tokens, batching deletes, mapping keys) is the driver's own, exercised
// through an injected client that scripts the responses. Note bun never
// restores mock.module, so this replacement outlives this file; the module
// is otherwise absent here, so the only behavior it can mask in another
// test is the missing-optional-dependency error.
await mock.module('@aws-sdk/client-s3', () => ({
  ListObjectsV2Command: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  DeleteObjectsCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
  GetObjectCommand: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
}))

// The presigner is only ever handed the command; echoing its input back as
// the "URL" lets tests assert what would have been signed.
await mock.module('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client: unknown, command: { input: Record<string, unknown> }) =>
    `https://presigned.example/?input=${encodeURIComponent(JSON.stringify(command.input))}`,
}))

import { S3Driver } from '../../src/storage/drivers/S3Driver'

interface ListPage {
  Contents?: Array<{ Key?: string }>
  CommonPrefixes?: Array<{ Prefix?: string }>
  IsTruncated?: boolean
  NextContinuationToken?: string
}

class FakeS3Client {
  readonly inputs: Array<Record<string, unknown>> = []

  constructor(private readonly pages: ListPage[]) {}

  async send(command: unknown): Promise<unknown> {
    this.inputs.push((command as { input: Record<string, unknown> }).input)
    const page = this.pages[this.inputs.length - 1]
    if (!page) {
      throw new Error(`Unexpected request #${this.inputs.length}: no page scripted`)
    }
    return page
  }
}

function makeDriver(pages: ListPage[], options: { prefix?: string } = {}) {
  const client = new FakeS3Client(pages)
  const driver = new S3Driver({
    client,
    bucket: 'bucket',
    ...options,
  })
  return { driver, client }
}

describe('S3Driver listing pagination', () => {
  it('allFiles follows continuation tokens until the listing is exhausted', async () => {
    const { driver, client } = makeDriver([
      {
        Contents: [{ Key: 'dir/a.txt' }, { Key: 'dir/b.txt' }],
        IsTruncated: true,
        NextContinuationToken: 'token-1',
      },
      {
        Contents: [{ Key: 'dir/c.txt' }],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      },
      {
        Contents: [{ Key: 'dir/d.txt' }],
        IsTruncated: false,
      },
    ])

    const files = await driver.allFiles('dir')

    expect(files).toEqual(['dir/a.txt', 'dir/b.txt', 'dir/c.txt', 'dir/d.txt'])
    expect(client.inputs).toHaveLength(3)
    expect(client.inputs[0]?.ContinuationToken).toBeUndefined()
    expect(client.inputs[1]?.ContinuationToken).toBe('token-1')
    expect(client.inputs[2]?.ContinuationToken).toBe('token-2')
  })

  it('directories aggregates common prefixes across pages', async () => {
    const { driver, client } = makeDriver([
      {
        CommonPrefixes: [{ Prefix: 'a/' }, { Prefix: 'b/' }],
        IsTruncated: true,
        NextContinuationToken: 'token-1',
      },
      {
        CommonPrefixes: [{ Prefix: 'c/' }],
        IsTruncated: false,
      },
    ])

    const directories = await driver.directories('')

    expect(directories).toEqual(['a', 'b', 'c'])
    expect(client.inputs).toHaveLength(2)
    expect(client.inputs[1]?.ContinuationToken).toBe('token-1')
    expect(client.inputs[1]?.Delimiter).toBe('/')
  })

  it('files aggregates keys across pages and strips the disk prefix', async () => {
    const { driver, client } = makeDriver(
      [
        {
          Contents: [{ Key: 'app/dir/a.txt' }, { Key: 'app/dir/' }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        },
        {
          Contents: [{ Key: 'app/dir/b.txt' }],
          IsTruncated: false,
        },
      ],
      { prefix: 'app' },
    )

    const files = await driver.files('dir')

    expect(files).toEqual(['dir/a.txt', 'dir/b.txt'])
    expect(client.inputs[0]?.Prefix).toBe('app/dir/')
    expect(client.inputs[1]?.ContinuationToken).toBe('token-1')
  })

  it('stops after a single page when the response is not truncated', async () => {
    const { driver, client } = makeDriver([
      { Contents: [{ Key: 'a.txt' }] },
    ])

    expect(await driver.allFiles('')).toEqual(['a.txt'])
    expect(client.inputs).toHaveLength(1)
  })

  it('lists from the disk prefix root without doubling the slash', async () => {
    const { driver, client } = makeDriver(
      [{ Contents: [{ Key: 'app/a.txt' }] }],
      { prefix: 'app' },
    )

    expect(await driver.allFiles('')).toEqual(['a.txt'])
    expect(client.inputs[0]?.Prefix).toBe('app/')
  })

  it('throws instead of returning an incomplete listing when a truncated response carries no token', async () => {
    const { driver } = makeDriver([
      { Contents: [{ Key: 'a.txt' }], IsTruncated: true },
    ])

    await expect(driver.allFiles('')).rejects.toThrow(/IsTruncated without an advancing/)
  })

  it('throws instead of looping when a truncated response repeats the previous token', async () => {
    const { driver, client } = makeDriver([
      { Contents: [{ Key: 'a.txt' }], IsTruncated: true, NextContinuationToken: 'token-1' },
      { Contents: [{ Key: 'b.txt' }], IsTruncated: true, NextContinuationToken: 'token-1' },
    ])

    await expect(driver.allFiles('')).rejects.toThrow(/IsTruncated without an advancing/)
    expect(client.inputs).toHaveLength(2)
  })
})

describe('S3Driver deleteMany batching', () => {
  it('splits deletes into DeleteObjects requests of at most 1000 keys', async () => {
    const client = {
      inputs: [] as Array<Record<string, unknown>>,
      async send(command: unknown): Promise<unknown> {
        const input = (command as { input: Record<string, unknown> }).input
        this.inputs.push(input)
        const objects = (input.Delete as { Objects: unknown[] }).Objects
        return { Deleted: objects }
      },
    }
    const driver = new S3Driver({ client, bucket: 'bucket' })

    const paths = Array.from({ length: 1001 }, (_, index) => `file-${index}.txt`)
    expect(await driver.deleteMany(paths)).toBe(1001)

    expect(client.inputs).toHaveLength(2)
    const batchSizes = client.inputs.map(
      (input) => (input.Delete as { Objects: unknown[] }).Objects.length,
    )
    expect(batchSizes).toEqual([1000, 1])
  })
})

describe('S3Driver streaming and delivery capabilities (RFC 0015)', () => {
  it('declares presignedGet — temporaryUrl is a real presign', () => {
    const driver = new S3Driver({ client: { send: async () => ({}) }, bucket: 'bucket' })
    expect(driver.capabilities).toEqual({ presignedGet: true })
  })

  it('getStream normalizes the SDK body via transformToWebStream', async () => {
    const bytes = new TextEncoder().encode('streamed')
    const client = {
      inputs: [] as Array<Record<string, unknown>>,
      async send(command: unknown): Promise<unknown> {
        this.inputs.push((command as { input: Record<string, unknown> }).input)
        return {
          Body: {
            transformToWebStream: () => new Blob([bytes]).stream(),
          },
        }
      },
    }
    const driver = new S3Driver({ client, bucket: 'bucket', prefix: 'media' })

    const stream = await driver.getStream('dir/a.bin')
    expect(stream).not.toBeNull()
    expect(Buffer.from(await new Response(stream!).arrayBuffer())).toEqual(Buffer.from(bytes))
    expect(client.inputs[0]?.Key).toBe('media/dir/a.bin')
    expect(client.inputs[0]?.Range).toBeUndefined()
  })

  it('getStream maps the range option onto an HTTP Range header', async () => {
    const client = {
      inputs: [] as Array<Record<string, unknown>>,
      async send(command: unknown): Promise<unknown> {
        this.inputs.push((command as { input: Record<string, unknown> }).input)
        return { Body: { transformToWebStream: () => new Blob([]).stream() } }
      },
    }
    const driver = new S3Driver({ client, bucket: 'bucket' })

    await driver.getStream('a.bin', { range: { start: 5, end: 9 } })
    await driver.getStream('a.bin', { range: { start: 7 } })

    expect(client.inputs[0]?.Range).toBe('bytes=5-9')
    expect(client.inputs[1]?.Range).toBe('bytes=7-')
  })

  it('getStream resolves null for a missing key', async () => {
    const client = {
      async send(): Promise<unknown> {
        const error = new Error('no such key')
        error.name = 'NoSuchKey'
        throw error
      },
    }
    const driver = new S3Driver({ client, bucket: 'bucket' })

    expect(await driver.getStream('missing.bin')).toBeNull()
  })

  it('temporaryUrl forwards response overrides into the presigned command', async () => {
    const driver = new S3Driver({ client: { send: async () => ({}) }, bucket: 'bucket' })

    const url = await driver.temporaryUrl('doc.pdf', new Date(Date.now() + 60_000), {
      responseContentDisposition: 'attachment; filename="doc.pdf"',
      responseContentType: 'application/pdf',
    })

    const input = JSON.parse(
      decodeURIComponent(new URL(url).searchParams.get('input') ?? '{}'),
    ) as Record<string, unknown>
    expect(input.ResponseContentDisposition).toBe('attachment; filename="doc.pdf"')
    expect(input.ResponseContentType).toBe('application/pdf')
    expect(input.Key).toBe('doc.pdf')
  })

  it('temporaryUrl omits response overrides when none are given', async () => {
    const driver = new S3Driver({ client: { send: async () => ({}) }, bucket: 'bucket' })

    const url = await driver.temporaryUrl('doc.pdf', new Date(Date.now() + 60_000))
    const input = JSON.parse(
      decodeURIComponent(new URL(url).searchParams.get('input') ?? '{}'),
    ) as Record<string, unknown>
    expect('ResponseContentDisposition' in input).toBe(false)
    expect('ResponseContentType' in input).toBe(false)
  })
})
