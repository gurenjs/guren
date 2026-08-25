import { describe, expect, it, mock } from 'bun:test'

// The AWS SDK is an optional peer that is not installed in this workspace.
// The driver only needs the command class as a carrier for its input, so a
// bare stand-in is enough — the logic under test (following continuation
// tokens, mapping keys) is the driver's own, exercised through an injected
// client that scripts the paged responses.
mock.module('@aws-sdk/client-s3', () => ({
  ListObjectsV2Command: class {
    constructor(readonly input: Record<string, unknown>) {}
  },
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

  it('stops when a truncated response carries no continuation token', async () => {
    const { driver, client } = makeDriver([
      { Contents: [{ Key: 'a.txt' }], IsTruncated: true },
    ])

    expect(await driver.allFiles('')).toEqual(['a.txt'])
    expect(client.inputs).toHaveLength(1)
  })
})
