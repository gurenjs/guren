import { Model, type PlainObject } from '@guren/orm'
import {
  getQueueDriver,
  setQueueDriver,
  HttpException,
  ValidationException,
  type StorageDriver,
  type StorageManager,
} from '@guren/server'
import { decodeJsonColumn, toDate } from '../store-utils.js'
import { resolveDefaultImageProcessor } from './bun-image-processor.js'
import type { AttachmentCollectionSpec, AttachmentsDeclaration, HeicPolicy } from './declaration.js'
import { sniffImage } from './image-sniff.js'
import type {
  AttachmentData,
  AttachmentRecord,
  AttachmentSource,
  AttachmentVariantRecord,
  ImagePolicy,
  ImageProcessor,
  VariantSpec,
} from './types.js'
import { ulid, ulidTime } from './ulid.js'

export interface AttachOptions {
  /** Filename to store (defaults to the `File`'s own name). */
  name?: string
  /** Disk to store on, overriding the configured default. */
  disk?: string
  /**
   * Defer the full decode and variant generation to the queue: the request
   * path runs only the synchronous gates (byte cap, header dimensions, HEIC
   * signature), stores the original, seeds declared variants as `pending`,
   * and dispatches `GenerateVariantsJob`. Until the worker runs, variant
   * URLs fall back to the original. Requires a queue — either
   * `configureAttachments({ queue })` or an already-booted QueueManager.
   */
  queued?: boolean
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
   * The app's QueueManager, resolved lazily (e.g.
   * `() => container.make('queue')`). Enables `attach(..., { queued: true })`:
   * the engine materializes the manager's default driver and dispatches
   * `GenerateVariantsJob` on it. Materializing the default driver installs
   * it as the process-wide dispatch target (`QueueManager` semantics), so
   * pass the same manager the rest of the app dispatches through — a
   * second manager here would redirect every later `Job.dispatch()` in the
   * process. Without this option, `queued: true` falls back to the
   * globally configured queue driver and throws a clear error when there
   * is none.
   */
  queue?: () => unknown
  /**
   * How long `temporaryUrl()` links for private disks stay valid, in
   * milliseconds.
   * @default 300_000 (5 minutes)
   */
  urlExpiresIn?: number
}

/**
 * What `GenerateVariantsJob` needs to finish a deferred attach. The specs
 * are snapshotted at dispatch time (they come from the model declaration,
 * never the call site), so an in-flight job is unaffected by later
 * declaration edits and the worker needs no model registry to resolve them.
 */
export interface GenerateVariantsPayload {
  attachmentId: string
  image?: ImagePolicy
  heic?: HeicPolicy
  variants?: Record<string, VariantSpec>
}

export interface PruneOptions {
  /** Also delete `attachments/` storage prefixes that no row references. */
  objects?: boolean
  /** Report what would be removed without deleting anything. */
  dryRun?: boolean
}

export interface PruneReport {
  /** Rows examined. */
  scannedRows: number
  /** Rows whose owning record no longer exists (deleted unless dry-run). */
  orphanRows: Array<{ id: string; attachableType: string; attachableId: string }>
  /**
   * Morph types that could not be verified and were left untouched: types
   * missing from `Model.morphMap`, or whose existence query failed. A type
   * that cannot be checked is never treated as absent — that would turn an
   * outage into a mass deletion.
   */
  skippedTypes: Array<{ type: string; reason: string }>
  /** Per disk, storage prefixes under `attachments/` with no row (with `objects`). */
  orphanObjectPrefixes: Array<{ disk: string; prefix: string }>
  /** Disks that could not be listed and were left untouched (with `objects`). */
  skippedDisks: Array<{ disk: string; reason: string }>
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
/**
 * How recently minted a storage prefix may be before `--objects` refuses to
 * touch it. attach() writes the object *before* the row, so a prefix without
 * a row is either debris — or an attach in flight. The prefix id is a ULID,
 * so its age is readable; anything younger than this window is skipped and
 * picked up by the next sweep if it really was abandoned.
 */
const PRUNE_OBJECTS_GRACE_MS = 60 * 60 * 1000
/** Existence lookups are chunked to stay inside every dialect's bind-parameter limits. */
const PRUNE_LOOKUP_CHUNK = 500

/**
 * The spellings under which an id may appear on either side of the prune
 * comparison: as stored (lowercased — UUID hex case is not identity) and,
 * for numeric values, the canonical numeric form ('01' and 1 are the same
 * key). Used symmetrically so a representation mismatch always errs toward
 * "the record exists".
 */
function idSpellings(value: unknown): string[] {
  const raw = String(value).toLowerCase()
  const spellings = [raw]
  if (/^\d+$/.test(raw)) {
    const canonical = String(Number(raw))
    if (canonical !== raw) spellings.push(canonical)
  }
  return spellings
}

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
  /** Whether decode and variant generation were deferred to the queue. */
  deferred?: boolean
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
  private readonly queue?: () => unknown
  private dispatchJob: ((payload: GenerateVariantsPayload) => Promise<unknown>) | null = null

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
    this.queue = options.queue
  }

  /** Wired by `configureAttachments()`; kept out of the constructor so this module never imports the job (which imports this module). */
  setJobDispatcher(dispatch: (payload: GenerateVariantsPayload) => Promise<unknown>): void {
    this.dispatchJob = dispatch
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

    const queued = options.queued === true
    if (queued) {
      // Fail before any byte is written: a missing queue must not leave a
      // stored original whose variants nobody will ever generate.
      this.ensureQueueDispatchable()
    }

    const inspection = await this.inspectImage(spec, collection, normalized, queued)

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

    const variants = await this.buildVariants(spec, id, disk, inspection)

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

    if (inspection.deferred) {
      try {
        await this.dispatchGeneration({
          attachmentId: id,
          image: spec.image,
          heic: spec.accepts?.heic,
          // Snapshot, not a reference: an in-memory queue keeps the payload
          // object alive, and a later mutation of the model declaration must
          // not rewrite a job that is already in flight.
          variants: spec.variants ? structuredClone(spec.variants) : undefined,
        })
      } catch (error) {
        // No job will ever finish this provisionally accepted upload — and
        // on an image: 'require' collection the full decode never ran, so
        // leaving the row would keep serving unvalidated bytes forever.
        // Undo the accept (the replaced attachment below is still intact)
        // and surface the queue failure to the caller.
        await this.purgeRows([row as PlainObject])
        throw error
      }
    }

    // Purged only after a deferred attach is durably enqueued: replacing
    // first would destroy the previous attachment even when the dispatch
    // fails and the new one is rolled back.
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
    const rows = await this.rowsForPage(model, records, names)

    const dataByRecord = new Map<string, Map<string, AttachmentData[]>>()
    for (const raw of rows) {
      const row = this.toRecord(raw)
      const spec = declaration[row.collection]
      if (!spec) continue
      const data = await this.toData(row, spec)
      let byCollection = dataByRecord.get(row.attachableId)
      if (!byCollection) {
        byCollection = new Map()
        dataByRecord.set(row.attachableId, byCollection)
      }
      let list = byCollection.get(row.collection)
      if (!list) {
        list = []
        byCollection.set(row.collection, list)
      }
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
    defer = false,
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
    if (sniffed.format === 'heic') {
      if ((spec.accepts?.heic ?? 'reject') === 'reject') {
        throw new HttpException(
          415,
          "HEIC/HEIF uploads are not accepted. Declare accepts: { heic: 'convert' } on the collection to convert them where the runtime supports it.",
        )
      }
      if (!this.processor && !defer) {
        throw new HttpException(415, 'HEIC/HEIF conversion is not available on this runtime.')
      }
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

    // Deferred attach: gate 3 and variant generation run in the queue
    // worker, even when this process has a processor — that is the point of
    // queued: true. Dimensions come from the header until the job updates
    // them; the one class that survives the synchronous checks (bytes whose
    // header lies) is detected after acceptance, by the job.
    if (defer) {
      return {
        width: sniffed.width ?? null,
        height: sniffed.height ?? null,
        placeholder: null,
        contentType: IMAGE_MIME[sniffed.format] ?? null,
        decoded: false,
        deferred: true,
        bytes: source.bytes,
        name: source.name,
      }
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
    spec: Pick<AttachmentCollectionSpec, 'variants'>,
    id: string,
    disk: StorageDriver,
    inspection: Pick<ImageInspection, 'bytes' | 'decoded' | 'deferred'>,
  ): Promise<Record<string, AttachmentVariantRecord> | null> {
    const declared = Object.entries(spec.variants ?? {}) as Array<[string, VariantSpec]>
    if (declared.length === 0) return null

    const variants: Record<string, AttachmentVariantRecord> = {}
    for (const [name, variantSpec] of declared) {
      if (inspection.deferred) {
        variants[name] = { status: 'pending' }
        continue
      }
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

  // --- deferred (queued) generation -----------------------------------------

  /**
   * Worker-side completion of a deferred attach (`GenerateVariantsJob`):
   * run the full decode that the request path skipped, convert a HEIC
   * original where the collection opted in, generate the declared variants,
   * and settle every `pending` status record. Safe against races — a row or
   * object purged while the job sat in the queue is simply nothing to do.
   */
  async generateVariants(payload: GenerateVariantsPayload): Promise<void> {
    const raw = (await this.model.where({ id: payload.attachmentId }).first()) as PlainObject | null
    if (!raw) return
    const row = this.toRecord(raw)
    const disk = this.storage().disk(row.disk)

    if (!this.processor) {
      // A worker without an image processor cannot finish the job — settle
      // rather than retry forever; URLs keep falling back to the original.
      // The one exception is a HEIC original accepted only because the
      // collection promised conversion: the synchronous path answers 415
      // for it on processor-less runtimes, so an image-required collection
      // must not keep serving it once the promise turns out unkeepable.
      if (payload.heic === 'convert' && payload.image === 'require' && row.contentType === 'image/heic') {
        await this.purgeRows([raw])
        return
      }
      await this.settleDeferred(row, 'unavailable')
      return
    }

    const stored = await disk.get(row.path)
    if (!stored) {
      await this.settleDeferred(row, 'failed')
      return
    }
    let bytes: Uint8Array = new Uint8Array(stored)

    let probed: { width: number; height: number; format: string; placeholder?: string }
    try {
      probed = await this.processor.probe(bytes, { maxPixels: this.maxPixels })
    } catch {
      // The synchronous gates accepted this upload on header evidence; the
      // full decode is the authority and it said no. Acceptance on an
      // image-required collection was provisional — purge it (RFC 0013 §6);
      // an image-optional collection keeps the bytes as an opaque file.
      if (payload.image === 'require') {
        await this.purgeRows([raw])
        return
      }
      await this.settleDeferred(row, 'failed', { clearImageMetadata: true })
      return
    }

    const updates: PlainObject = {
      width: probed.width,
      height: probed.height,
      placeholder: probed.placeholder ?? null,
    }

    const sniffed = sniffImage(bytes.subarray(0, SNIFF_WINDOW_BYTES))
    let supersededPath: string | null = null
    if (sniffed?.format === 'heic' && payload.heic === 'convert') {
      const converted = await this.processor.process(bytes, { format: 'jpeg' })
      const name = replaceExtension(row.name, 'jpg')
      const path = `attachments/${row.id}/${name}`
      await disk.put(path, Buffer.from(converted.bytes), { contentType: 'image/jpeg' })
      // The old object is deleted only after the row commit below repoints
      // to the new one: deleting first would leave the row referencing
      // nothing if anything past this line failed — and the retry would
      // then find no bytes and settle 'failed', a silent broken link. A
      // leaked superseded object is the recoverable failure; a row
      // pointing at nothing is not.
      if (path !== row.path) {
        supersededPath = row.path
      }
      bytes = converted.bytes
      updates.name = name
      updates.path = path
      updates.contentType = 'image/jpeg'
      updates.size = converted.bytes.byteLength
      updates.width = converted.width
      updates.height = converted.height
    }

    const variants = await this.buildVariants({ variants: payload.variants }, row.id, disk, {
      bytes,
      decoded: true,
    })
    if (variants) {
      updates.variants = variants
    }
    updates.updatedAt = new Date()

    // The attachment can be replaced or detached while this job was
    // generating: its purge deletes the prefix, and the puts above would
    // silently recreate orphan objects under it. Re-check the row and clean
    // up after ourselves instead of leaving objects only a bucket audit
    // would find.
    const still = await this.model.where({ id: row.id }).first()
    if (!still) {
      await disk.deleteDirectory(`attachments/${row.id}`)
      return
    }
    await this.model.forceUpdate({ id: row.id }, updates)

    if (supersededPath) {
      try {
        await disk.delete(supersededPath)
      } catch {
        // The row already points at the converted object; a superseded
        // original that failed to delete is a leak for the sweeper, not a
        // job failure.
      }
    }
  }

  /** `GenerateVariantsJob.failed()`: settle `pending` records after the last retry. */
  async markDeferredFailed(attachmentId: string): Promise<void> {
    await this.settleDeferred({ id: attachmentId }, 'failed')
  }

  /**
   * Flip every `pending` variant to a terminal status so nothing looks
   * in-flight forever. Works on a *fresh* read of the row, never a caller's
   * snapshot: under at-least-once delivery a duplicate execution can hold a
   * stale copy whose `pending` entries would otherwise clobber the variants
   * a completed run already marked `ready`.
   */
  private async settleDeferred(
    row: Pick<AttachmentRecord, 'id'>,
    status: 'failed' | 'unavailable',
    options: { clearImageMetadata?: boolean } = {},
  ): Promise<void> {
    const fresh = (await this.model.where({ id: row.id }).first()) as PlainObject | null
    if (!fresh) return
    const current = this.toRecord(fresh)

    const updates: PlainObject = { updatedAt: new Date() }
    let changed = false
    if (current.variants) {
      const variants = { ...current.variants }
      for (const [name, entry] of Object.entries(variants)) {
        if (entry.status === 'pending') {
          variants[name] = { status }
          changed = true
        }
      }
      if (changed) {
        updates.variants = variants
      }
    }
    if (options.clearImageMetadata) {
      updates.width = null
      updates.height = null
      updates.placeholder = null
      changed = true
    }
    if (!changed) return
    await this.model.forceUpdate({ id: row.id }, updates)
  }

  /**
   * A queued attach needs somewhere to dispatch to: the configured
   * QueueManager's default driver, or — when no `queue` option was given —
   * whatever queue driver the app has already booted globally.
   */
  private ensureQueueDispatchable(): void {
    if (!this.dispatchJob) {
      throw new Error('Attachments queue dispatch is not wired. Call configureAttachments() before attaching.')
    }
    if (this.queue) {
      const manager = this.queue() as { driver?: () => unknown } | null | undefined
      if (typeof manager?.driver !== 'function') {
        throw new Error(
          'configureAttachments({ queue }) must resolve to a QueueManager (an object with a driver() method).',
        )
      }
      // Job.dispatch() sends through the module-global driver, and
      // QueueManager.driver() installs its default there only on *first*
      // resolution — the cached branch does not. Reassert it on every
      // dispatch, or a job could land on whichever driver another manager
      // installed since, where no worker of ours ever pops.
      setQueueDriver(manager.driver() as Parameters<typeof setQueueDriver>[0])
      return
    }
    if (!getQueueDriver()) {
      throw new Error(
        "attach() with queued: true requires a queue. Pass configureAttachments({ queue: () => queueManager }) or boot the app's queue before attaching.",
      )
    }
  }

  private async dispatchGeneration(payload: GenerateVariantsPayload): Promise<void> {
    this.ensureQueueDispatchable()
    await this.dispatchJob!(payload)
  }

  /**
   * The single indexed query behind `withAttachments()`. An empty `records`
   * or `names` short-circuits: either would send an empty `IN ()` list to the
   * adapter rather than matching nothing.
   */
  private async rowsForPage(
    model: typeof Model,
    records: readonly PlainObject[],
    names: readonly string[],
  ): Promise<PlainObject[]> {
    const ids = records.map((record) => String(record.id))
    if (ids.length === 0 || names.length === 0) return []
    const rows = (await this.model.where({
      attachableType: model.name,
      attachableId: ids,
      collection: [...names],
    })) as PlainObject[]
    return sortById(rows)
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
    // Chunked like the prune lookups: a sweep can hand this thousands of
    // ids, and one unbounded IN would blow dialect bind-parameter limits —
    // after the objects above are already gone.
    for (let start = 0; start < ids.length; start += PRUNE_LOOKUP_CHUNK) {
      await this.model.where({ id: ids.slice(start, start + PRUNE_LOOKUP_CHUNK) }).delete()
    }
  }

  /**
   * The sweeper behind `attachments:prune` (RFC 0013 §8): no DB cascade can
   * exist for a polymorphic pair, so deletion is explicit-plus-sweep. Rows
   * are removed only on *positive* evidence the record is gone — the owning
   * type resolved through `Model.morphMap` and the record queried and found
   * missing. Anything unverifiable (type not in the morph map, a failing
   * query, an unlistable disk) is reported and left alone.
   */
  async pruneOrphans(options: PruneOptions = {}): Promise<PruneReport> {
    // Unscoped on purpose: configureAttachments() hands this model to the
    // app, which may add global scopes (a tenant filter, say). A scoped
    // snapshot would hide other tenants' rows from `liveIds` and --objects
    // would then sweep prefixes that are very much referenced.
    const rows = (await this.model.withoutGlobalScopes()) as PlainObject[]
    const report: PruneReport = {
      scannedRows: rows.length,
      orphanRows: [],
      skippedTypes: [],
      orphanObjectPrefixes: [],
      skippedDisks: [],
    }

    const byType = new Map<string, PlainObject[]>()
    for (const row of rows) {
      const type = String(row.attachableType)
      const group = byType.get(type)
      if (group) group.push(row)
      else byType.set(type, [row])
    }

    const morphMap = Model.morphMap ?? {}
    const orphans: PlainObject[] = []
    for (const [type, group] of byType) {
      const relatedModel = morphMap[type]
      if (!relatedModel) {
        report.skippedTypes.push({
          type,
          reason: `'${type}' is not in Model.morphMap — set Model.morphMap = { ${type} } so its records can be checked.`,
        })
        continue
      }
      const ids = Array.from(new Set(group.map((row) => String(row.attachableId))))
      const existing = new Set<string>()
      const unverifiable = new Set<string>()
      // Bounded chunks: one IN over every id (twice, with both spellings)
      // blows dialect parameter limits on large tables, and the catch would
      // then skip the whole type — leaving its real orphans unswept forever.
      for (let start = 0; start < ids.length; start += PRUNE_LOOKUP_CHUNK) {
        const chunk = ids.slice(start, start + PRUNE_LOOKUP_CHUNK)
        // The morph column stores ids as text while the owning table's key
        // may be numeric; query both spellings so a representation mismatch
        // can never make a live record look deleted. Number() is lossy above
        // 2^53; harmless because the string spelling rides alongside.
        const lookupValues = chunk.flatMap((id) => (/^\d+$/.test(id) ? [id, Number(id)] : [id]))
        try {
          // Existence is a primary-key fact, so every global scope is
          // dropped: a SoftDeletes filter would make a soft-deleted
          // (restorable!) record's attachments look orphaned, and a tenant
          // filter would let one tenant's sweep delete another's.
          const records = (await relatedModel
            .withoutGlobalScopes()
            .where({ id: lookupValues })) as PlainObject[]
          for (const record of records) {
            for (const spelling of idSpellings(record.id)) existing.add(spelling)
          }
        } catch (error) {
          for (const id of chunk) unverifiable.add(id)
          report.skippedTypes.push({
            type,
            reason: `querying ${type} failed (${error instanceof Error ? error.message : String(error)}) — records that cannot be checked are not deleted ones.`,
          })
        }
      }
      for (const row of group) {
        const stored = String(row.attachableId)
        if (unverifiable.has(stored)) continue
        // Membership through the same normalization on both sides: '01' in
        // the morph column must match an integer key of 1, and a UUID must
        // match regardless of hex case.
        if (idSpellings(stored).some((spelling) => existing.has(spelling))) continue
        orphans.push(row)
        report.orphanRows.push({
          id: String(row.id),
          attachableType: type,
          attachableId: stored,
        })
      }
    }

    if (!options.dryRun && orphans.length > 0) {
      await this.purgeRows(orphans)
    }

    if (options.objects) {
      await this.pruneOrphanObjects(rows, orphans, report, options.dryRun === true)
    }

    return report
  }

  /** With `--objects`: storage prefixes under `attachments/` that no surviving row references. */
  private async pruneOrphanObjects(
    rows: PlainObject[],
    removedRows: PlainObject[],
    report: PruneReport,
    dryRun: boolean,
  ): Promise<void> {
    const removed = new Set(removedRows.map((row) => String(row.id)))
    const liveIds = new Set(
      rows.map((row) => String(row.id)).filter((id) => !removed.has(id)),
    )

    // Every disk the sweep can know about: the registered set (a disk used
    // once via attach({ disk }) whose only write crashed pre-row would
    // otherwise never be examined), plus config and row-referenced names.
    let registered: string[] = []
    try {
      registered = this.storage().getDiskNames()
    } catch {
      // A storage manager that cannot enumerate simply contributes nothing.
    }
    const diskNames = new Set<string>([
      ...registered,
      this.defaultDisk,
      ...Object.keys(this.diskVisibility),
      ...rows.map((row) => String(row.disk)),
    ])

    for (const diskName of diskNames) {
      let prefixes: string[]
      let disk: StorageDriver
      try {
        disk = this.storage().disk(diskName)
        prefixes = await disk.directories('attachments')
      } catch (error) {
        report.skippedDisks.push({
          disk: diskName,
          reason: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      for (const prefix of prefixes) {
        const id = prefix.split('/').pop() ?? prefix
        if (liveIds.has(id)) continue
        // A rowless prefix minted moments ago is an attach() in flight (the
        // object is written before the row), not debris — leave it for a
        // later sweep. Non-ULID names carry no timestamp and cannot be a
        // mid-flight attach, so they are swept.
        const mintedAt = ulidTime(id)
        if (mintedAt !== null && Date.now() - mintedAt < PRUNE_OBJECTS_GRACE_MS) continue
        report.orphanObjectPrefixes.push({ disk: diskName, prefix })
        if (!dryRun) {
          try {
            await disk.deleteDirectory(prefix)
          } catch (error) {
            // One failing prefix must not abort the sweep of everything
            // after it — the rows are already gone by this point.
            report.skippedDisks.push({
              disk: diskName,
              reason: `deleting ${prefix} failed: ${error instanceof Error ? error.message : String(error)}`,
            })
          }
        }
      }
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
    if (left < right) return -1
    if (left > right) return 1
    return 0
  })
}
