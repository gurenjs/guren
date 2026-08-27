import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Attachable,
  configureAttachments,
  defineModel,
  deriveAppKeyring,
  DrizzleAdapter,
  generateAppKey,
  getAppKeyringFromEnv,
  hasOneAttached,
  registerAttachmentRoutes,
  Router,
  StorageManager,
  verifySignedUrl,
  type ConfigureAttachmentsOptions,
  type StorageDriver,
  type TemporaryUrlOptions,
} from '../src/index'
import { getActiveAttachmentEngine, setActiveAttachmentEngine } from '../src/attachments/engine'
import { ATTACHMENTS_DDL, attachmentsTable } from './attachments-table'
import { PNG_1X1 } from './image-sniff.test'

const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ image: 'require', variants: { thumb: { width: 2, format: 'png' } } }),
  doc: hasOneAttached(),
}) {}

function deliveryKeyring() {
  return deriveAppKeyring(getAppKeyringFromEnv(), 'attachment-delivery')
}

/** Serve a minted URL through the engine, the way the controller would. */
async function serve(
  url: string,
  init: { method?: string; ifNoneMatch?: string } = {},
): Promise<Response> {
  const engine = getActiveAttachmentEngine()!
  const absolute = new URL(url, 'http://app.test')
  const id = decodeURIComponent(absolute.pathname.split('/')[2] ?? '')
  return engine.handleDeliveryRequest({
    url: absolute,
    id,
    variant: absolute.searchParams.get('variant') ?? undefined,
    disposition: absolute.searchParams.get('disposition') ?? undefined,
    ifNoneMatch: init.ifNoneMatch,
    method: init.method ?? 'GET',
  })
}

describe('attachments signed delivery (RFC 0015)', () => {
  let sqlite: Database
  let storage: StorageManager
  let tmpDir: string
  let previousAppKey: string | undefined

  function configure(overrides: Partial<ConfigureAttachmentsOptions> = {}) {
    return configureAttachments({
      table: attachmentsTable,
      storage: () => storage,
      disk: 'vault',
      processor: null,
      disks: { media: 'public', vault: 'private' },
      delivery: {},
      ...overrides,
    })
  }

  beforeEach(() => {
    previousAppKey = process.env.APP_KEY
    process.env.APP_KEY = generateAppKey()
    sqlite = new Database(':memory:')
    sqlite.exec(`
      ${ATTACHMENTS_DDL}
      CREATE TABLE posts (id integer primary key, title text not null);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
    tmpDir = mkdtempSync(join(tmpdir(), 'guren-delivery-'))
    storage = new StorageManager({
      default: 'vault',
      disks: {
        media: { driver: 'memory', url: 'https://cdn.test' },
        vault: { driver: 'local', root: tmpDir, url: '/storage' },
      },
    })
    configure()
  })

  afterEach(() => {
    sqlite.close()
    setActiveAttachmentEngine(null)
    rmSync(tmpDir, { recursive: true, force: true })
    if (previousAppKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = previousAppKey
  })

  function attachCover() {
    return Post.attach(1, 'cover', new File([PNG_1X1], 'cover.png', { type: 'image/png' }))
  }

  describe('URL generation', () => {
    test('private disks mint relative signed route URLs', async () => {
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')

      expect(url).not.toBeNull()
      expect(url!.startsWith('/attachments/')).toBe(true)
      expect(url).toContain('expires=')
      expect(url).toContain('signature=')
      expect(verifySignedUrl(url!, deliveryKeyring(), { requireExpiration: true })).toBe(true)
    })

    test('variant URLs carry the variant as a signed parameter', async () => {
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover', { variant: 'thumb' })

      expect(url).toContain('variant=thumb')
      expect(verifySignedUrl(url!, deliveryKeyring(), { requireExpiration: true })).toBe(true)
    })

    test('public disks keep plain disk URLs', async () => {
      const record = await Post.attach(1, 'cover', new File([PNG_1X1], 'c.png', { type: 'image/png' }), {
        disk: 'media',
      })
      const url = await Post.attachmentUrl(1, 'cover')

      expect(url).toBe(`https://cdn.test/${record.path}`)
    })

    test('without delivery config, private disks keep the v1 temporaryUrl behaviour', async () => {
      configure({ delivery: undefined })
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')

      expect(url!.startsWith('/storage/')).toBe(true)
      expect(url).not.toContain('signature=')
    })

    test("serve: 'direct' opts a disk back out of the route", async () => {
      configure({ disks: { vault: { visibility: 'private', serve: 'direct' } } })
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')

      expect(url!.startsWith('/storage/')).toBe(true)
    })

    test('expiresIn overrides the configured lifetime for one URL', async () => {
      await attachCover()
      const short = await Post.attachmentUrl(1, 'cover')
      const long = await Post.attachmentUrl(1, 'cover', { expiresIn: 3_600_000 })

      const expiresOf = (url: string) =>
        Number(new URL(url, 'http://x.test').searchParams.get('expires'))
      expect(expiresOf(long!)).toBeGreaterThan(expiresOf(short!))
    })

    test('a custom prefix flows into minted URLs and the route registration', async () => {
      configure({ delivery: { prefix: '/files' } })
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')
      expect(url!.startsWith('/files/')).toBe(true)

      const router = new Router()
      registerAttachmentRoutes(router)
      const definition = router.definitions().find((route) => route.path.startsWith('/files/'))
      expect(definition?.path).toBe('/files/:id/:filename')
      expect(definition?.method.toUpperCase()).toBe('GET')
      expect(definition?.name).toBe('attachments.show')
    })

    test('registration without any engine registers the default route and does not throw', () => {
      setActiveAttachmentEngine(null)
      const router = new Router()
      registerAttachmentRoutes(router)

      const definition = router.definitions().find((route) => route.path.startsWith('/attachments/'))
      expect(definition?.path).toBe('/attachments/:id/:filename')
    })
  })

  describe('serving (proxy)', () => {
    test('serves the original bytes with the hardening headers', async () => {
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')
      const response = await serve(url!)

      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG_1X1))
      expect(response.headers.get('Content-Type')).toBe('image/png')
      expect(response.headers.get('Content-Disposition')).toContain('inline')
      expect(response.headers.get('Content-Disposition')).toContain('cover.png')
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(response.headers.get('Content-Security-Policy')).toBe('sandbox')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(response.headers.get('Cache-Control')).toMatch(/^private, max-age=\d+$/)
      expect(response.headers.get('ETag')).toMatch(/^".+"$/)
      expect(response.headers.get('Content-Length')).toBe(String(PNG_1X1.byteLength))
    })

    test('disposition=attachment is honoured; non-allowlisted types are forced to attachment', async () => {
      await attachCover()
      const forcedUrl = await Post.attachmentUrl(1, 'cover', { disposition: 'attachment' })
      const forced = await serve(forcedUrl!)
      expect(forced.status).toBe(200)
      expect(forced.headers.get('Content-Disposition')).toContain('attachment')

      // An SVG is stored fine but must never render inline same-origin —
      // even with no disposition parameter at all.
      await Post.attach(2, 'doc', new File(['<svg onload="alert(1)"/>'], 'evil.svg', { type: 'image/svg+xml' }))
      const svgUrl = await Post.attachmentUrl(2, 'doc')
      const svgResponse = await serve(svgUrl!)

      expect(svgResponse.status).toBe(200)
      expect(svgResponse.headers.get('Content-Disposition')).toContain('attachment')
    })

    test('a not-ready variant serves the original; tampering with the variant 404s', async () => {
      await attachCover()
      // processor: null ⇒ thumb is recorded but never generated.
      const url = await Post.attachmentUrl(1, 'cover', { variant: 'thumb' })
      const response = await serve(url!)

      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG_1X1))

      const tampered = url!.replace('variant=thumb', 'variant=og')
      expect((await serve(tampered)).status).toBe(404)
    })

    test('a ready variant serves the variant bytes with its own MIME type', async () => {
      const record = await attachCover()
      const engine = getActiveAttachmentEngine()!
      const variantPath = `attachments/${record.id}/variants/thumb.webp`
      const variantBytes = Buffer.from('variant-bytes')
      await storage.disk('vault').put(variantPath, variantBytes)
      await engine.model.forceUpdate(
        { id: record.id },
        {
          variants: {
            thumb: { status: 'ready', path: variantPath, format: 'webp', size: variantBytes.byteLength },
          },
        },
      )

      const url = await Post.attachmentUrl(1, 'cover', { variant: 'thumb' })
      const response = await serve(url!)

      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(variantBytes)
      expect(response.headers.get('Content-Type')).toBe('image/webp')
      expect(response.headers.get('Content-Length')).toBe(String(variantBytes.byteLength))
    })

    test('404 is uniform: bad signature, expired URL, unknown id', async () => {
      const record = await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')

      expect((await serve(`${url}x`)).status).toBe(404)

      const expired = await Post.attachmentUrl(1, 'cover', { expiresIn: -1000 })
      expect((await serve(expired!)).status).toBe(404)

      await Post.purgeAttachments(1)
      expect((await serve(url!)).status).toBe(404)
      // The 404 must not leak whether the id ever existed.
      expect(record.id).toBeTruthy()
    })

    test('If-None-Match returns 304 and HEAD skips the body', async () => {
      await attachCover()
      const url = await Post.attachmentUrl(1, 'cover')

      const first = await serve(url!)
      const etag = first.headers.get('ETag')!
      const cached = await serve(url!, { ifNoneMatch: etag })
      expect(cached.status).toBe(304)
      expect(cached.headers.get('Content-Length')).toBeNull()

      const head = await serve(url!, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.body).toBeNull()
      expect(head.headers.get('Content-Length')).toBe(String(PNG_1X1.byteLength))
    })

    test('memory disks without getStream fall back to buffered get()', async () => {
      configure({ disks: { media: 'private' } })
      await Post.attach(3, 'cover', new File([PNG_1X1], 'm.png', { type: 'image/png' }), {
        disk: 'media',
      })
      const url = await Post.attachmentUrl(3, 'cover')
      const response = await serve(url!)

      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG_1X1))
    })
  })

  describe('serving (redirect)', () => {
    function presigningDriver(base: StorageDriver): StorageDriver {
      const captured: { expiration?: Date; options?: TemporaryUrlOptions } = {}
      const driver = Object.create(base) as StorageDriver & {
        captured: typeof captured
      }
      Object.defineProperty(driver, 'capabilities', { value: { presignedGet: true } })
      driver.temporaryUrl = async (path, expiration, options) => {
        captured.expiration = expiration
        captured.options = options
        return `https://bucket.test/presigned/${path}`
      }
      driver.captured = captured
      return driver
    }

    function withPresigningVault() {
      const base = storage.disk('vault')
      const driver = presigningDriver(base)
      const manager = { disk: () => driver } as unknown as StorageManager
      configure({ storage: () => manager })
      return driver as StorageDriver & {
        captured: { expiration?: Date; options?: TemporaryUrlOptions }
      }
    }

    test('presign-capable disks 302 to a per-request presigned URL with response overrides', async () => {
      const driver = withPresigningVault()
      const record = await Post.attach(1, 'cover', new File([PNG_1X1], 'c.png', { type: 'image/png' }))
      const url = await Post.attachmentUrl(1, 'cover')
      const response = await serve(url!)

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe(`https://bucket.test/presigned/${record.path}`)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(driver.captured.options?.responseContentType).toBe('image/png')
      expect(driver.captured.options?.responseContentDisposition).toContain('inline')
      // The inner presign is minted per request and capped by urlExpiresIn.
      expect(driver.captured.expiration!.getTime()).toBeLessThanOrEqual(Date.now() + 300_000 + 1000)
    })

    test("serve: 'proxy' keeps a presign-capable disk on the proxy path", async () => {
      const base = storage.disk('vault')
      const driver = presigningDriver(base)
      const manager = { disk: () => driver } as unknown as StorageManager
      configure({
        storage: () => manager,
        disks: { vault: { visibility: 'private', serve: 'proxy' } },
      })
      await Post.attach(1, 'cover', new File([PNG_1X1], 'c.png', { type: 'image/png' }))
      const url = await Post.attachmentUrl(1, 'cover')
      const response = await serve(url!)

      expect(response.status).toBe(200)
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(PNG_1X1))
    })
  })
})
