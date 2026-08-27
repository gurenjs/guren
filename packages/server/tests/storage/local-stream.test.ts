import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDriver } from '../../src/storage'
import type { StorageDriver } from '../../src/storage'

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer())
}

describe('LocalDriver.getStream', () => {
  let driver: LocalDriver
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'guren-storage-stream-'))
    driver = new LocalDriver({ root: tmpDir, url: '/storage' })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('streams the same bytes get() returns', async () => {
    const content = Buffer.from('streaming works, byte for byte')
    await driver.put('files/a.bin', content)

    const stream = await driver.getStream('files/a.bin')
    expect(stream).not.toBeNull()
    expect(await readAll(stream!)).toEqual(content)
  })

  it('resolves null for a missing file (verified before the stream is returned)', async () => {
    expect(await driver.getStream('missing.bin')).toBeNull()
  })

  it('resolves null for a directory', async () => {
    await mkdir(join(tmpDir, 'a-directory'))
    expect(await driver.getStream('a-directory')).toBeNull()
  })

  it('honours an inclusive byte range', async () => {
    await driver.put('range.bin', Buffer.from('0123456789'))

    const middle = await driver.getStream('range.bin', { range: { start: 2, end: 5 } })
    expect((await readAll(middle!)).toString()).toBe('2345')

    const tail = await driver.getStream('range.bin', { range: { start: 7 } })
    expect((await readAll(tail!)).toString()).toBe('789')
  })

  it('declares no capabilities (temporaryUrl is not a presign)', () => {
    expect((driver as StorageDriver).capabilities).toBeUndefined()
  })
})
