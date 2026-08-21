import { Model, type PlainObject } from '@guren/orm'
import { HttpException, ValidationException, type StorageDriver, type StorageManager } from '@guren/server'
import { decodeJsonColumn, toDate } from '../store-utils.js'
import { resolveDefaultImageProcessor } from './bun-image-processor.js'
import type { AttachmentCollectionSpec, AttachmentsDeclaration } from './declaration.js'
import { sniffImage } from './image-sniff.js'
import type {
  AttachmentData,
  AttachmentRecord,
  AttachmentSource,
  AttachmentVariantRecord,
  ImageProcessor,
  VariantSpec,
} from './types.js'
import { ulid } from './ulid.js'

export interface AttachOptions {
  /** Filename to store (defaults to the `File`'s own name). */
  name?: string
  /** Disk to store on, overriding the configured default. */
  disk?: string
}

export interface ConfigureAttachmentsOptions {
  /**
   * The app's Drizzle `attachments` table (the app owns the table; the
   * framework ships the schema snippet — see the attachments guide).
   * Column property names must match the documented contract: `id`,
   * `attachableType`, `attachableId`, `collection`, `disk`, `path`, `name`,
   * `contentType`, `size`, `width`, `height`, `variants` (JSON-capable),
   * `placeholder`, `createdAt`, `updatedAt`.
   */
  table: unknown
  /** The app's StorageManager, resolved lazily (e.g. `() => container.make('storage')`). */
  storage: () => StorageManager
  /** Default disk name for new attachments. */
  disk: string
  /**
   * Per-disk visibility: `'public'` disks serve via `disk.url()`, `'private'`
   * ones via `disk.temporaryUrl()`. Per disk, not per attachment, because at
   * least one driver (R2) has no per-object visibility. Undeclared disks
   * default to `'public'`.
   */
  disks?: Record<string, 'public' | 'private'>
  /**
   * Decode cap in pixels (decompression-bomb defense). Header-declared and
   * decoded dimensions above this are rejected before a pixel buffer is
   * allocated. No "unlimited" setting exists; photography/archival apps
   * raise it deliberately and should isolate their image workers.
   * @default 52_000_000
   */
  maxPixels?: number
  /**
   * Encoded-input cap in bytes, checked before any decode. Pixel count and
   * upload size defend against different attacks; this is the cheapest gate.
   * @default 50_000_000
   */
  maxImageBytes?: number
  /**
   * Image processor override. Defaults to the Bun-native processor when the
   * runtime has `Bun.Image`; pass `null` to force the processor-less path
   * (variants recorded as `unavailable`, validation stops at the header
   * gates) or your own implementation (e.g. sharp-backed) on other runtimes.
   */
  processor?: ImageProcessor | null
  /**
   * The app's queue manager, resolved lazily. Reserved for queued variant
   * generation (a follow-up release); accepted now so config written today
   * keeps working then.
   */
  queue?: () => unknown
  /**
   * How long `temporaryUrl()` links for private disks stay valid, in
   * milliseconds.
   * @default 300_000 (5 minutes)
   */
  urlExpiresIn?: number
}

const DEFAULT_MAX_PIXELS = 52_000_000
/**
 * Header sniffing only ever needs the first bytes; capping the window keeps
 * the JPEG marker walk O(cap) instead of O(input) on attacker-sized bytes
 * that reach the sniffer before the byte-cap gate applies (image: 'allow'
 * collections must not size-reject non-image files).
 */
const SNIFF_WINDOW_BYTES = 262_144
const DEFAULT_MAX_IMAGE_BYTES = 50_000_000
const DEFAULT_URL_EXPIRES_IN = 5 * 60 * 1000

const IMAGE_MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heic: 'image/heic',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
}

const VARIANT_EXTENSION: Record<string, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
}

interface NormalizedSource {
  bytes: Uint8Array
  name: string
  declaredContentType: string | null
}

interface ImageInspection {
  width: number | null
  height: number | null
  placeholder: string | null
  contentType: string | null
  /** Whether a full decode succeeded (variants can be generated). */
  decoded: boolean
  bytes: Uint8Array
  name: string
}

export class AttachmentEngine {
  readonly model: typeof Model
  private readonly storage: () => StorageManager
  private readonly defaultDisk: string
  private readonly diskVisibility: Record<string, 'public' | 'private'>
  private readonly maxPixels: number
  private readonly maxImageBytes: number
  private readonly processor: ImageProcessor | null
  private readonly urlExpiresIn: number

  constructor(options: ConfigureAttachmentsOptions) {
    const table = options.table
    this.model = class AttachmentModel extends Model {
      static override table = table
    }
    this.model.morphTo('attachable', 'attachable')

    this.storage = options.storage
    this.defaultDisk = options.disk
    this.diskVisibility = options.disks ?? {}
    this.maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    this.processor =
      options.processor !== undefined ? options.processor : resolveDefaultImageProcessor(this.maxPixels)
    this.urlExpiresIn = options.urlExpiresIn ?? DEFAULT_URL_EXPIRES_IN
  }

  async attach(
    model: typeof Model,
    declaration: AttachmentsDeclaration,
    recordId: string | number,
    collection: string,
    source: AttachmentSource,
    options: AttachOptions = {},
  ): Promise<AttachmentRecord> {
    const spec = this.specFor(model, declaration, collection)
    const normalized = await normalizeSource(source, options.name)

    const inspection = await this.inspectImage(spec, collection, normalized)

    const id = ulid()
    const name = inspection.name
    const path = `attachments/${id}/${name}`
    const diskName = options.disk ?? this.defaultDisk
    const disk = this.storage().disk(diskName)
    const contentType = inspection.contentType ?? normalized.declaredContentType ?? 'application/octet-stream'

    // On a hasOne collection the new attachment replaces the old one. Read
    // the rows to purge *before* writing, purge them only *after* the new
    // row exists: a failed put must never leave the record without its
    // attachment.
    const replaced =
      spec.kind === 'one' ? await this.rowsFor(model, recordId, { collection }) : []

    await disk.put(path, Buffer.from(inspection.bytes), { contentType })

    const variants = await this.buildVariants(spec, id, diskName, disk, inspection)

    const now = new Date()
    const row = await this.model.forceCreate({
      id,
      attachableType: model.name,
      attachableId: String(recordId),
      collection,
      disk: diskName,
      path,
      name,
      contentType,
      size: inspection.bytes.byteLength,
      width: inspection.width,
      height: inspection.height,
      variants,
      placeholder: inspection.placeholder,
      createdAt: now,
      updatedAt: now,
    })

    if (replaced.length > 0) {
      await this.purgeRows(replaced)
    }

    return this.toRecord(row)
  }

  async detach(
    model: typeof Model,
    declaration: AttachmentsDeclaration,
    recordId: string | number,
    collection: string,
    attachmentId?: string,
  ): Promise<void> {
    const spec = this.specFor(model, declaration, collection)
    if (spec.kind === 'one' && attachmentId !== undefined) {
      throw new Error(
        `${model.name}.detach(): '${collection}' is a hasOne collection — it has no attachment id to select.`,
      )
    }
    const rows = await this.rowsFor(model, recordId, { collection, id: attachmentId })
    await this.purgeRows(rows)
  }

  async withAttachments(
    model: typeof Model,
    declaration: AttachmentsDeclaration,
    records: readonly PlainObject[],
    names: readonly string[],
  ): Promise<PlainObject[]> {
    for (const name of names) this.specFor(model, declaration, name)
    const ids = records.map((record) => String(record.id))
    const rows =
      ids.length === 0 || names.length === 0
        ? []
        : sortById(
            (await this.model.where({
              attachableType: model.name,
              attachableId: ids,
              collection: [...names],
            })) as PlainObject[],
          )

    const dataByRecord = new Map<string, Map<string, AttachmentData[]>>()
    for (const raw of rows) {
      const row = this.toRecord(raw)
      const spec = declaration[row.collection]
      if (!spec) continue
      const data = await this.toData(row, spec)
      let byCollection = dataByRecord.get(row.attachableId)
      if (!byCollection) dataByRecord.set(row.attachableId, (byCollection = new Map()))
      let list = byCollection.get(row.collection)
      if (!list) byCollection.set(row.collection, (list = []))
      list.push(data)
    }

    return records.map((record) => {
      const byCollection = dataByRecord.get(String(record.id))
      const attached: PlainObject = { ...record }
      for (const name of names) {
        const spec = declaration[name]!
        const list = byCollection?.get(name) ?? []
        // hasOne resolves to the newest row (see attachmentUrl on why).
        attached[name] = spec.kind === 'many' ? list : (list[list.length - 1] ?? null)
      }
      return attached
    })
  }

  async attachmentUrl(
    model: typeof Model,
    declaration: AttachmentsDeclaration,
    recordOrId: PlainObject | string | number,
    collection: string,
    options: { variant?: string } = {},
  ): Promise<string | null> {
    const spec = this.specFor(model, declaration, collection)
    const variant = options.variant
    if (variant !== undefined && !(variant in (spec.variants ?? {}))) {
      // A declared-but-not-generated variant falls back to the original; a
      // name that was never declared is a programming error and must not
      // degrade into silently serving the original.
      throw new Error(
        `${model.name}.attachmentUrl(): variant '${variant}' is not declared on collection '${collection}'.`,
      )
    }

    const recordId =
      typeof recordOrId === 'object' ? (recordOrId as { id?: string | number }).id : recordOrId
    if (recordId == null) return null

    const rows = sortById(await this.rowsFor(model, recordId, { collection }))
    // hasOne reads the *newest* row: a crash between attach()'s write-new
    // and purge-old steps leaves two rows, and the stale one must not win.
    const raw = spec.kind === 'one' ? rows[rows.length - 1] : rows[0]
    if (!raw) return null
    const row = this.toRecord(raw)

    if (variant !== undefined) {
      const entry = row.variants?.[variant]
      if (entry?.status === 'ready' && entry.path) {
        return this.urlFor(row.disk, entry.path)
      }
      // pending / failed / unavailable: serve the original so pages keep
      // rendering; a later render picks the variant up automatically.
    }
    return this.urlFor(row.disk, row.path)
  }

  async purgeAttachments(model: typeof Model, recordId: string | number): Promise<void> {
    const rows = await this.rowsFor(model, recordId, {})
    await this.purgeRows(rows)
  }

  // --- internals -----------------------------------------------------------

  private specFor(
    model: typeof Model,
    declaration: AttachmentsDeclaration,
    collection: string,
  ): AttachmentCollectionSpec {
    const spec = declaration[collection]
    if (!spec) {
      throw new Error(
        `${model.name} declares no attachment collection '${collection}'. Declared: ${Object.keys(declaration).join(', ') || '(none)'}.`,
      )
    }
    return spec
  }

  /**
   * The three-gate image pipeline (RFC 0013 §6): (1) encoded-byte cap,
   * (2) header-dimension cap, (3) full decode. Gates 1-2 plus the HEIC
   * signature rejection are pure JS and run on every runtime; only the full
   * decode needs a processor.
   */
  private async inspectImage(
    spec: AttachmentCollectionSpec,
    collection: string,
    source: NormalizedSource,
  ): Promise<ImageInspection> {
    const opaque: ImageInspection = {
      width: null,
      height: null,
      placeholder: null,
      contentType: null,
      decoded: false,
      bytes: source.bytes,
      name: source.name,
    }
    const policy = spec.image
    if (policy === undefined) return opaque

    const sniffed = sniffImage(source.bytes.subarray(0, SNIFF_WINDOW_BYTES))

    if (policy === 'forbid') {
      if (sniffed) {
        throw new ValidationException({ [collection]: ['The file must not be an image.'] })
      }
      return opaque
    }

    if (!sniffed) {
      if (policy === 'require') {
        throw new ValidationException({ [collection]: ['The file must be an image.'] })
      }
      return opaque
    }

    // Gate 1: encoded-input cap — cheapest, before any header math.
    if (source.bytes.byteLength > this.maxImageBytes) {
      throw new HttpException(
        413,
        `Image exceeds the maximum allowed size of ${this.maxImageBytes} bytes.`,
      )
    }

    // HEIC is rejected by signature alone: decoding it is an OS-codec
    // property (works on a macOS dev machine, fails on Linux production),
    // and the default must not let that skew pass silently.
    const heicPolicy = spec.accepts?.heic ?? 'reject'
    if (sniffed.format === 'heic' && heicPolicy === 'reject') {
      throw new HttpException(
        415,
        "HEIC/HEIF uploads are not accepted. Declare accepts: { heic: 'convert' } on the collection to convert them where the runtime supports it.",
      )
    }
    if (sniffed.format === 'heic' && !this.processor) {
      throw new HttpException(415, 'HEIC/HEIF conversion is not available on this runtime.')
    }

    // Gate 2: header-declared dimensions, before any pixel buffer exists.
    // The decoder allocates from these numbers, so this is the gate that
    // actually prevents the allocation.
    if (sniffed.width != null && sniffed.height != null && sniffed.width * sniffed.height > this.maxPixels) {
      throw new ValidationException({
        [collection]: [
          `Image dimensions ${sniffed.width}x${sniffed.height} exceed the maximum of ${this.maxPixels} pixels.`,
        ],
      })
    }

    // Gate 3: the full decode is the validation authority. Without a
    // processor it defers — the upload is accepted on header evidence and
    // dimensions come from the header (graceful degrade; RFC 0013 §5).
    if (!this.processor) {
      return {
        width: sniffed.width ?? null,
        height: sniffed.height ?? null,
        placeholder: null,
        contentType: IMAGE_MIME[sniffed.format] ?? null,
        decoded: false,
        bytes: source.bytes,
        name: source.name,
      }
    }

    let probed: { width: number; height: number; format: string; placeholder?: string }
    try {
      probed = await this.processor.probe(source.bytes, { maxPixels: this.maxPixels })
    } catch (error) {
      if (errorCode(error) === 'ERR_IMAGE_FORMAT_UNSUPPORTED') {
        throw new HttpException(415, `This runtime cannot decode ${sniffed.format} images.`)
      }
      if (policy === 'require') {
        throw new ValidationException({ [collection]: ['The file must be a valid image.'] })
      }
      return opaque
    }

    if (sniffed.format === 'heic') {
      // accepts.heic 'convert': store a JPEG original so the stored object
      // is decodable everywhere the app might later run.
      const converted = await this.processor.process(source.bytes, { format: 'jpeg' })
      return {
        width: converted.width,
        height: converted.height,
        placeholder: probed.placeholder ?? null,
        contentType: 'image/jpeg',
        decoded: true,
        bytes: converted.bytes,
        name: replaceExtension(source.name, 'jpg'),
      }
    }

    return {
      width: probed.width,
      height: probed.height,
      placeholder: probed.placeholder ?? null,
      contentType: IMAGE_MIME[probed.format] ?? IMAGE_MIME[sniffed.format] ?? null,
      decoded: true,
      bytes: source.bytes,
      name: source.name,
    }
  }

  /**
   * Seed one entry per *declared* variant and generate inline where a
   * processor exists. Recording declared names (not just generated ones) is
   * what lets `attachmentUrl()` tell "not yet generated" from "never
   * declared" after a reload.
   */
  private async buildVariants(
    spec: AttachmentCollectionSpec,
    id: string,
    diskName: string,
    disk: StorageDriver,
    inspection: ImageInspection,
  ): Promise<Record<string, AttachmentVariantRecord> | null> {
    const declared = Object.entries(spec.variants ?? {}) as Array<[string, VariantSpec]>
    if (declared.length === 0) return null

    const variants: Record<string, AttachmentVariantRecord> = {}
    for (const [name, variantSpec] of declared) {
      if (!this.processor) {
        variants[name] = { status: 'unavailable' }
        continue
      }
      if (!inspection.decoded) {
        variants[name] = { status: 'failed' }
        continue
      }
      try {
        const result = await this.processor.process(inspection.bytes, variantSpec)
        const extension = VARIANT_EXTENSION[result.format] ?? result.format
        const path = `attachments/${id}/variants/${name}.${extension}`
        await disk.put(path, Buffer.from(result.bytes), {
          contentType: IMAGE_MIME[result.format] ?? 'application/octet-stream',
        })
        variants[name] = {
          status: 'ready',
          path,
          width: result.width,
          height: result.height,
          format: result.format as AttachmentVariantRecord['format'],
          size: result.bytes.byteLength,
        }
      } catch {
        variants[name] = { status: 'failed' }
      }
    }
    return variants
  }

  private async rowsFor(
    model: typeof Model,
    recordId: string | number,
    filter: { collection?: string; id?: string },
  ): Promise<PlainObject[]> {
    const where: PlainObject = {
      attachableType: model.name,
      attachableId: String(recordId),
    }
    if (filter.collection !== undefined) where.collection = filter.collection
    if (filter.id !== undefined) where.id = filter.id
    return (await this.model.where(where)) as PlainObject[]
  }

  /**
   * Objects first, rows after (RFC 0013 §8): a crash between the two leaves
   * a row pointing at nothing, which the next `url()` surfaces loudly — the
   * reverse would leave invisible orphaned objects only a bucket audit finds.
   */
  private async purgeRows(rows: PlainObject[]): Promise<void> {
    for (const row of rows) {
      const disk = this.storage().disk(String(row.disk))
      await disk.deleteDirectory(`attachments/${String(row.id)}`)
    }
    const ids = rows.map((row) => String(row.id))
    if (ids.length > 0) {
      await this.model.where({ id: ids }).delete()
    }
  }

  private visibilityOf(diskName: string): 'public' | 'private' {
    return this.diskVisibility[diskName] ?? 'public'
  }

  private async urlFor(diskName: string, path: string): Promise<string> {
    const disk = this.storage().disk(diskName)
    if (this.visibilityOf(diskName) === 'private') {
      return disk.temporaryUrl(path, new Date(Date.now() + this.urlExpiresIn))
    }
    return disk.url(path)
  }

  private async toData(row: AttachmentRecord, spec: AttachmentCollectionSpec): Promise<AttachmentData> {
    const originalUrl = await this.urlFor(row.disk, row.path)
    const variants: AttachmentData['variants'] = {}
    for (const name of Object.keys(spec.variants ?? {})) {
      const entry = row.variants?.[name]
      if (entry?.status === 'ready' && entry.path) {
        variants[name] = {
          url: await this.urlFor(row.disk, entry.path),
          width: entry.width ?? null,
          height: entry.height ?? null,
        }
      } else {
        // Declared but not (yet) generated: fall back to the original so
        // pages keep rendering; the placeholder LQIP covers the gap.
        variants[name] = { url: originalUrl, width: null, height: null }
      }
    }
    return {
      id: row.id,
      collection: row.collection,
      name: row.name,
      contentType: row.contentType,
      size: row.size,
      width: row.width,
      height: row.height,
      url: originalUrl,
      placeholder: row.placeholder,
      variants,
    }
  }

  private toRecord(row: PlainObject): AttachmentRecord {
    return {
      id: String(row.id),
      attachableType: String(row.attachableType),
      attachableId: String(row.attachableId),
      collection: String(row.collection),
      disk: String(row.disk),
      path: String(row.path),
      name: String(row.name),
      contentType: String(row.contentType),
      size: Number(row.size),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      variants:
        row.variants == null
          ? null
          : decodeJsonColumn<Record<string, AttachmentVariantRecord>>(row.variants, {}),
      placeholder: row.placeholder == null ? null : String(row.placeholder),
      createdAt: toDate(row.createdAt) ?? new Date(0),
      updatedAt: toDate(row.updatedAt) ?? new Date(0),
    }
  }
}

// --- module-level wiring ----------------------------------------------------

let activeEngine: AttachmentEngine | null = null

/** Install the engine `configureAttachments()` built. Last call wins; `null` unconfigures (tests). */
export function setActiveAttachmentEngine(engine: AttachmentEngine | null): void {
  activeEngine = engine
}

export function resolveAttachmentEngine(caller: string): AttachmentEngine {
  if (!activeEngine) {
    throw new Error(
      `${caller} requires attachments to be configured. Call configureAttachments({ table, storage, disk }) once at boot (e.g. in config/attachments.ts) before using the attachment statics.`,
    )
  }
  return activeEngine
}

// --- helpers ----------------------------------------------------------------

async function normalizeSource(source: AttachmentSource, nameOverride?: string): Promise<NormalizedSource> {
  if (source instanceof Uint8Array) {
    return {
      bytes: source,
      name: sanitizeFilename(nameOverride ?? 'file'),
      declaredContentType: null,
    }
  }
  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer())
    const fileName = 'name' in source && typeof source.name === 'string' ? source.name : undefined
    return {
      bytes,
      name: sanitizeFilename(nameOverride ?? fileName ?? 'file'),
      declaredContentType: source.type || null,
    }
  }
  // Deliberately no path-string form: a filesystem path here would be an
  // arbitrary-file-read primitive (RFC 0013 §6).
  throw new TypeError(
    'attach() accepts bytes only (File, Blob, or Uint8Array). Filesystem path strings are not supported.',
  )
}

/**
 * Filenames become part of the object key, so they must not steer it: no
 * path separators, no control characters, never empty or dot-only.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200)
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'file'
  return cleaned
}

function replaceExtension(name: string, extension: string): string {
  const stem = name.replace(/\.[^.]*$/, '')
  return `${stem === '' ? 'file' : stem}.${extension}`
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

/** ULIDs sort lexicographically by creation time; compare code units, not locales. */
function sortById(rows: PlainObject[]): PlainObject[] {
  return [...rows].sort((a, b) => {
    const left = String(a.id)
    const right = String(b.id)
    return left < right ? -1 : left > right ? 1 : 0
  })
}
