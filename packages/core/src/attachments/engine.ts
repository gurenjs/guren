import { createHash } from 'node:crypto'
import { Model, type PlainObject } from '@guren/orm'
import {
  deriveAppKeyring,
  getAppKeyringFromEnv,
  getQueueDriver,
  setQueueDriver,
  signUrl,
  verifySignedUrl,
  HttpException,
  ValidationException,
  type AppKeyring,
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
   * Defer the full decode and variant generation to the queue: the request path
   * runs only the synchronous gates, stores the original, seeds declared
   * variants as `pending`, and dispatches `GenerateVariantsJob`. Variant URLs
   * fall back to the original until the worker runs. Requires a queue.
   */
  queued?: boolean
}

export interface ConfigureAttachmentsOptions {
  /**
   * The app's Drizzle `attachments` table. Column property names must match the
   * documented contract: `id`, `attachableType`, `attachableId`, `collection`,
   * `disk`, `path`, `name`, `contentType`, `size`, `width`, `height`,
   * `variants` (JSON-capable), `placeholder`, `createdAt`, `updatedAt`.
   */
  table: unknown
  /** The app's StorageManager, resolved lazily (e.g. `() => container.make('storage')`). */
  storage: () => StorageManager
  /** Default disk name for new attachments. */
  disk: string
  /**
   * Per-disk visibility, and with the object form how a private disk's bytes are
   * served (RFC 0015 §3). Per disk, not per attachment, because at least one
   * driver (R2) has no per-object visibility. Undeclared disks are `'public'`.
   */
  disks?: Record<string, DiskDeliveryConfig>
  /**
   * Signed delivery route configuration (RFC 0015). Presence switches
   * private-disk URLs from `disk.temporaryUrl()` to signed route URLs; the route
   * itself is mounted by `registerAttachmentRoutes(router)`.
   */
  delivery?: DeliveryOptions
  /**
   * Decode cap in pixels (decompression-bomb defense); header-declared and
   * decoded dimensions above it are rejected before a pixel buffer exists.
   * There is deliberately no "unlimited" setting.
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
   * Defaults to the Bun-native processor when the runtime has `Bun.Image`. Pass
   * `null` to force the processor-less path (variants `unavailable`, validation
   * stops at the header gates), or your own implementation.
   */
  processor?: ImageProcessor | null
  /**
   * The app's QueueManager, resolved lazily; enables `attach(..., { queued })`.
   * Materializing its default driver installs that driver process-wide, so pass
   * the same manager the rest of the app dispatches through — a second one would
   * redirect every later `Job.dispatch()`. Without this option, `queued: true`
   * falls back to the globally configured driver.
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
 * What `GenerateVariantsJob` needs to finish a deferred attach. Specs are
 * snapshotted at dispatch time, so an in-flight job survives later declaration
 * edits and the worker needs no model registry.
 */
export interface GenerateVariantsPayload {
  attachmentId: string
  image?: ImagePolicy
  heic?: HeicPolicy
  variants?: Record<string, VariantSpec>
}

/**
 * How a private disk's bytes are served behind the signed route (RFC 0015 §3).
 * `'auto'` redirects only on a driver's *declared* `capabilities.presignedGet`,
 * never a probe: `LocalDriver.temporaryUrl()` succeeds with a plain public URL,
 * so probing would misclassify exactly the disk that must not redirect.
 * `'direct'` bypasses the route entirely for v1's raw `temporaryUrl()` URLs.
 */
export type DeliveryServeMode = 'auto' | 'redirect' | 'proxy' | 'direct'

export type DiskDeliveryConfig =
  | 'public'
  | 'private'
  | { visibility: 'public' | 'private'; serve?: DeliveryServeMode }

/**
 * Per-URL options for `attachmentUrl()`. `disposition` accepts only
 * `'attachment'`: the route's allowlist can never be forced to inline, so a
 * signed `inline` value would change the URL while doing nothing.
 */
export interface AttachmentUrlOptions {
  expiresIn?: number
  disposition?: 'attachment'
}

/**
 * The public union normalized once at the constructor boundary: `'direct'`
 * splits into `route: false` (minting bypasses the route) plus `serve: 'auto'`
 * (a URL signed before the config change still serves), so no later branch has
 * to remember that `direct` secretly means `auto`.
 */
interface ResolvedDiskDelivery {
  visibility: 'public' | 'private'
  route: boolean
  serve: 'auto' | 'redirect' | 'proxy'
}

export interface DeliveryOptions {
  /**
   * Route prefix the delivery URLs live under.
   * @default '/attachments'
   */
  prefix?: string
  /**
   * `Router.name()` silently overwrites duplicates, so the default is reserved
   * for the framework.
   * @default 'attachments.show'
   */
  routeName?: string
}

/**
 * The single storage key prefix every attachment object lives under:
 * `attachments/<id>/<name>` originals, `attachments/<id>/variants/…`
 * derivatives, `attachments/` the prune sweep's listing. Exported because
 * `guren check` names `<disk root>/attachments` from another package; a restated
 * copy there would stop matching when this moves and report an exposed app safe.
 */
export const ATTACHMENT_OBJECT_PREFIX = 'attachments'

export const DEFAULT_DELIVERY_PREFIX = '/attachments'
export const DEFAULT_DELIVERY_ROUTE_NAME = 'attachments.show'

/**
 * The inner (presigned) TTL behind a redirect. Fixed, not derived from
 * `urlExpiresIn`: it is minted per request and need not outlive one fetch, and
 * deriving it could exceed a driver's presign ceiling (R2 rejects over 7 days).
 */
const INNER_PRESIGN_TTL_MS = 5 * 60 * 1000

export interface PruneOptions {
  /** Also delete `attachments/` storage prefixes that no row references. */
  objects?: boolean
  /** Report what would be removed without deleting anything. */
  dryRun?: boolean
}

export interface PruneReport {
  /** Rows examined. */
  scannedRows: number
  /** Rows whose owning record is gone (deleted unless dry-run). */
  orphanRows: Array<{ id: string; attachableType: string; attachableId: string }>
  /**
   * Morph types that could not be verified and were left untouched. A type that
   * cannot be checked is never treated as absent: that turns an outage into a
   * mass deletion.
   */
  skippedTypes: Array<{ type: string; reason: string }>
  /** Per disk, storage prefixes under `attachments/` with no row (with `objects`). */
  orphanObjectPrefixes: Array<{ disk: string; prefix: string }>
  /** Disks that could not be listed and were left untouched (with `objects`). */
  skippedDisks: Array<{ disk: string; reason: string }>
}

const DEFAULT_MAX_PIXELS = 52_000_000
/**
 * Caps the JPEG marker walk at O(cap) rather than O(input) on attacker-sized
 * bytes that reach the sniffer before the byte-cap gate applies (`image:
 * 'allow'` collections must not size-reject non-image files).
 */
const SNIFF_WINDOW_BYTES = 262_144
const DEFAULT_MAX_IMAGE_BYTES = 50_000_000
const DEFAULT_URL_EXPIRES_IN = 5 * 60 * 1000
/**
 * How recently minted a storage prefix may be before `--objects` refuses to
 * touch it. attach() writes the object *before* the row, so a rowless prefix is
 * either debris or an attach in flight; the ULID id makes its age readable.
 */
const PRUNE_OBJECTS_GRACE_MS = 60 * 60 * 1000
/** Existence lookups are chunked to stay inside every dialect's bind-parameter limits. */
const PRUNE_LOOKUP_CHUNK = 500

/**
 * The spellings an id may appear under on either side of the prune comparison:
 * lowercased (UUID hex case is not identity) and, for numeric values, the
 * canonical numeric form ('01' and 1 are one key). Used symmetrically so a
 * representation mismatch errs toward "the record exists".
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
  private readonly diskDelivery: Record<string, ResolvedDiskDelivery>
  private readonly delivery: { prefix: string; routeName: string } | null
  private deliveryKeys: AppKeyring | null = null
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
    this.diskDelivery = normalizeDiskDelivery(options.disks ?? {})
    this.delivery = options.delivery
      ? {
          prefix: normalizeDeliveryPrefix(options.delivery.prefix ?? DEFAULT_DELIVERY_PREFIX),
          routeName: options.delivery.routeName ?? DEFAULT_DELIVERY_ROUTE_NAME,
        }
      : null
    this.maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
    this.processor =
      options.processor !== undefined ? options.processor : resolveDefaultImageProcessor(this.maxPixels)
    this.urlExpiresIn = options.urlExpiresIn ?? DEFAULT_URL_EXPIRES_IN
    this.queue = options.queue
  }

  /** Wired by `configureAttachments()`, so this module never imports the job. */
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
      // Before any byte is written: a missing queue must not leave a stored
      // original whose variants nobody will ever generate.
      this.ensureQueueDispatchable()
    }

    const inspection = await this.inspectImage(spec, collection, normalized, queued)

    const id = ulid()
    const name = inspection.name
    const path = `${ATTACHMENT_OBJECT_PREFIX}/${id}/${name}`
    const diskName = options.disk ?? this.defaultDisk
    const disk = this.storage().disk(diskName)
    const contentType = inspection.contentType ?? normalized.declaredContentType ?? 'application/octet-stream'

    // Read the rows to purge *before* writing, purge them only *after* the new
    // row exists: a failed put must not leave the record without an attachment.
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
          // alive, and a later declaration edit must not rewrite a job in flight.
          variants: spec.variants ? structuredClone(spec.variants) : undefined,
        })
      } catch (error) {
        // No job will finish this provisionally accepted upload, and on an
        // `image: 'require'` collection the full decode never ran — leaving the
        // row would serve unvalidated bytes forever.
        await this.purgeRows([row as PlainObject])
        throw error
      }
    }

    // Only after a deferred attach is durably enqueued: purging first would
    // destroy the previous attachment when the dispatch fails and rolls back.
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
    options: AttachmentUrlOptions & { variant?: string } = {},
  ): Promise<string | null> {
    const spec = this.specFor(model, declaration, collection)
    const variant = options.variant
    if (variant !== undefined && !(variant in (spec.variants ?? {}))) {
      // A declared-but-not-generated variant falls back to the original; an
      // undeclared name is a programming error, not a silent fallback.
      throw new Error(
        `${model.name}.attachmentUrl(): variant '${variant}' is not declared on collection '${collection}'.`,
      )
    }

    const recordId =
      typeof recordOrId === 'object' ? (recordOrId as { id?: string | number }).id : recordOrId
    if (recordId == null) return null

    const rows = sortById(await this.rowsFor(model, recordId, { collection }))
    // The *newest* row: a crash between attach()'s write-new and purge-old steps
    // leaves two, and the stale one must not win.
    const raw = spec.kind === 'one' ? rows[rows.length - 1] : rows[0]
    if (!raw) return null
    const row = this.toRecord(raw)

    return this.urlForRow(row, {
      variant,
      expiresIn: options.expiresIn,
      disposition: options.disposition,
    })
  }

  async purgeAttachments(model: typeof Model, recordId: string | number): Promise<void> {
    const rows = await this.rowsFor(model, recordId, {})
    await this.purgeRows(rows)
  }

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
   * The three-gate image pipeline (RFC 0013 §6): encoded-byte cap, header
   * dimensions, full decode. The first two plus the HEIC signature rejection are
   * pure JS; only the full decode needs a processor.
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

    if (source.bytes.byteLength > this.maxImageBytes) {
      throw new HttpException(
        413,
        `Image exceeds the maximum allowed size of ${this.maxImageBytes} bytes.`,
      )
    }

    // By signature alone: HEIC decoding is an OS-codec property (macOS dev
    // machine yes, Linux production no), and that skew must not pass silently.
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

    // Gate 2. The decoder allocates from these header numbers, so this is the
    // gate that actually prevents the allocation.
    if (sniffed.width != null && sniffed.height != null && sniffed.width * sniffed.height > this.maxPixels) {
      throw new ValidationException({
        [collection]: [
          `Image dimensions ${sniffed.width}x${sniffed.height} exceed the maximum of ${this.maxPixels} pixels.`,
        ],
      })
    }

    // Gate 3 and variant generation run in the worker even when this process has
    // a processor. Dimensions come from the header until the job updates them,
    // so bytes whose header lies are only detected after acceptance.
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

    // Gate 3: the full decode is the validation authority. Without a processor
    // the upload is accepted on header evidence alone (RFC 0013 §5).
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
      // Store a JPEG original, decodable everywhere the app might later run.
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
   * Seed one entry per *declared* variant, generating inline where a processor
   * exists. Recording declared names is what lets `attachmentUrl()` tell "not
   * yet generated" from "never declared" after a reload.
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
        const path = `${ATTACHMENT_OBJECT_PREFIX}/${id}/variants/${name}.${extension}`
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

  /**
   * Worker-side completion of a deferred attach: the skipped full decode, any
   * opted-in HEIC conversion, the declared variants, and settling every
   * `pending` record. A row or object purged meanwhile is nothing to do.
   */
  async generateVariants(payload: GenerateVariantsPayload): Promise<void> {
    const raw = (await this.model.where({ id: payload.attachmentId }).first()) as PlainObject | null
    if (!raw) return
    const row = this.toRecord(raw)
    const disk = this.storage().disk(row.disk)

    if (!this.processor) {
      // Settle rather than retry forever; URLs keep falling back to the
      // original. The exception is a HEIC original accepted only because the
      // collection promised conversion — an image-required collection must not
      // keep serving it once that promise turns out unkeepable.
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
      // The synchronous gates accepted on header evidence; the full decode is
      // the authority. Acceptance was provisional on an image-required
      // collection, so purge; an image-optional one keeps opaque bytes.
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
      const path = `${ATTACHMENT_OBJECT_PREFIX}/${row.id}/${name}`
      await disk.put(path, Buffer.from(converted.bytes), { contentType: 'image/jpeg' })
      // Only after the row commit below repoints to the new object: deleting
      // first leaves the row referencing nothing if anything later fails, and
      // the retry settles 'failed' on a silent broken link. A leaked superseded
      // object is the recoverable failure; a row pointing at nothing is not.
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

    // A replace or detach while this job ran deletes the prefix, and the puts
    // above would silently recreate orphan objects under it.
    const still = await this.model.where({ id: row.id }).first()
    if (!still) {
      await disk.deleteDirectory(`${ATTACHMENT_OBJECT_PREFIX}/${row.id}`)
      return
    }
    await this.model.forceUpdate({ id: row.id }, updates)

    if (supersededPath) {
      try {
        await disk.delete(supersededPath)
      } catch {
        // The row already points at the converted object, so a superseded
        // original that failed to delete is a leak for the sweeper.
      }
    }
  }

  /** `GenerateVariantsJob.failed()`: settle `pending` records after the last retry. */
  async markDeferredFailed(attachmentId: string): Promise<void> {
    await this.settleDeferred({ id: attachmentId }, 'failed')
  }

  /**
   * Flip every `pending` variant to a terminal status. Works on a *fresh* read
   * of the row: under at-least-once delivery a duplicate execution holding a
   * stale copy would clobber variants a completed run already marked `ready`.
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
   * The configured QueueManager's default driver, or with no `queue` option
   * whatever driver the app has already booted globally.
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
      // Job.dispatch() sends through the module-global driver, which
      // QueueManager.driver() installs only on *first* resolution. Reassert on
      // every dispatch, or a job lands on whichever driver another manager
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
   * The single indexed query behind `withAttachments()`. Empty `records` or
   * `names` short-circuits: either would send an empty `IN ()` to the adapter.
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
   * Objects first, rows after (RFC 0013 §8): a crash between the two leaves a
   * row pointing at nothing, which the next `url()` surfaces loudly. The reverse
   * leaves orphaned objects only a bucket audit finds.
   */
  private async purgeRows(rows: PlainObject[]): Promise<void> {
    for (const row of rows) {
      const disk = this.storage().disk(String(row.disk))
      await disk.deleteDirectory(`${ATTACHMENT_OBJECT_PREFIX}/${String(row.id)}`)
    }
    const ids = rows.map((row) => String(row.id))
    // A sweep can hand this thousands of ids, and one unbounded IN would blow
    // dialect bind-parameter limits — after the objects above are already gone.
    for (let start = 0; start < ids.length; start += PRUNE_LOOKUP_CHUNK) {
      await this.model.where({ id: ids.slice(start, start + PRUNE_LOOKUP_CHUNK) }).delete()
    }
  }

  /**
   * The sweeper behind `attachments:prune` (RFC 0013 §8): no DB cascade exists
   * for a polymorphic pair. Rows are removed only on *positive* evidence the
   * record is gone; anything unverifiable is reported and left alone.
   */
  async pruneOrphans(options: PruneOptions = {}): Promise<PruneReport> {
    // Unscoped: the app may add global scopes to this model, and a scoped
    // snapshot would hide rows from `liveIds` so --objects sweeps referenced
    // prefixes.
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
      // One IN over every id (twice, both spellings) blows dialect parameter
      // limits on large tables, and the catch then skips the whole type.
      for (let start = 0; start < ids.length; start += PRUNE_LOOKUP_CHUNK) {
        const chunk = ids.slice(start, start + PRUNE_LOOKUP_CHUNK)
        // The morph column stores ids as text while the owning key may be
        // numeric, so query both spellings. Number() is lossy above 2^53, which
        // is harmless because the string spelling rides alongside.
        const lookupValues = chunk.flatMap((id) => (/^\d+$/.test(id) ? [id, Number(id)] : [id]))
        try {
          // Every global scope is dropped: SoftDeletes would make a restorable
          // record's attachments look orphaned, and a tenant filter would let
          // one tenant's sweep delete another's.
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
        // Same normalization on both sides: '01' must match an integer key of 1,
        // and a UUID must match regardless of hex case.
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

    // The registered set plus config and row-referenced names: a disk used once
    // via attach({ disk }) whose only write crashed pre-row is in none of the
    // others.
    let registered: string[] = []
    try {
      registered = this.storage().getDiskNames()
    } catch {
      // A storage manager that cannot enumerate simply contributes nothing.
    }
    const diskNames = new Set<string>([
      ...registered,
      this.defaultDisk,
      ...Object.keys(this.diskDelivery),
      ...rows.map((row) => String(row.disk)),
    ])

    for (const diskName of diskNames) {
      let prefixes: string[]
      let disk: StorageDriver
      try {
        disk = this.storage().disk(diskName)
        prefixes = await disk.directories(ATTACHMENT_OBJECT_PREFIX)
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
        // A rowless prefix minted moments ago is an attach() in flight, not
        // debris. Non-ULID names carry no timestamp and cannot be mid-flight.
        const mintedAt = ulidTime(id)
        if (mintedAt !== null && Date.now() - mintedAt < PRUNE_OBJECTS_GRACE_MS) continue
        report.orphanObjectPrefixes.push({ disk: diskName, prefix })
        if (!dryRun) {
          try {
            await disk.deleteDirectory(prefix)
          } catch (error) {
            // The rows are already gone, so one failing prefix must not abort
            // the rest of the sweep.
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
    return this.diskDelivery[diskName]?.visibility ?? 'public'
  }

  private serveModeFor(diskName: string): 'auto' | 'redirect' | 'proxy' {
    return this.diskDelivery[diskName]?.serve ?? 'auto'
  }

  /** Whether URL minting for this disk goes through the delivery route (`serve: 'direct'` opts out). */
  private routeEnabledFor(diskName: string): boolean {
    return this.diskDelivery[diskName]?.route ?? true
  }

  /** The normalized delivery route config, for `resolveDeliveryRoute()`. */
  get deliveryRoute(): { prefix: string; routeName: string } | null {
    return this.delivery
  }

  private deliveryKeyring(): AppKeyring {
    // Lazy so the env is read at first use; the derived keyring is scoped, so a
    // leaked delivery key forges delivery URLs and nothing else.
    if (!this.deliveryKeys) {
      this.deliveryKeys = deriveAppKeyring(getAppKeyringFromEnv(), 'attachment-delivery')
    }
    return this.deliveryKeys
  }

  /**
   * The one URL policy (RFC 0015 §7): public disks stay on `disk.url()`; private
   * disks get signed route URLs when `delivery` is configured and the disk did
   * not opt out with `serve: 'direct'`, else v1's `temporaryUrl()`.
   */
  private usesDeliveryRoute(row: AttachmentRecord): boolean {
    return (
      this.visibilityOf(row.disk) === 'private' && this.delivery !== null && this.routeEnabledFor(row.disk)
    )
  }

  /**
   * The one variant-resolution rule (RFC 0013 §7 / RFC 0015 §1), shared by URL
   * minting, resource payloads, and the delivery route. A `ready` entry resolves
   * to the variant's key and *format-derived* MIME type — variants are
   * transcoded, and serving them under the original's type with `nosniff` would
   * be self-sabotage. Anything else falls back to the original.
   */
  private resolveVariantTarget(
    row: AttachmentRecord,
    variant?: string,
  ): { path: string; contentType: string; size: number | null; ready: boolean } {
    const entry = variant ? row.variants?.[variant] : undefined
    if (entry?.status === 'ready' && entry.path) {
      return {
        path: entry.path,
        contentType: (entry.format && IMAGE_MIME[entry.format]) || 'application/octet-stream',
        size: entry.size ?? null,
        ready: true,
      }
    }
    return { path: row.path, contentType: row.contentType, size: row.size, ready: false }
  }

  private async urlForRow(
    row: AttachmentRecord,
    options: AttachmentUrlOptions & { variant?: string },
  ): Promise<string> {
    if (this.usesDeliveryRoute(row)) {
      return this.signDeliveryUrl(row, options)
    }

    // A declared-but-not-ready variant resolves to the original's key.
    const { path } = this.resolveVariantTarget(row, options.variant)
    const disk = this.storage().disk(row.disk)
    if (this.visibilityOf(row.disk) === 'private') {
      return disk.temporaryUrl(path, new Date(Date.now() + (options.expiresIn ?? this.urlExpiresIn)))
    }
    return disk.url(path)
  }

  /**
   * Path-relative: the `Host` header never participates in URL construction (RFC
   * 0015 T6). The variant rides as a signed query parameter resolved at *serve*
   * time, so the same URL starts serving it once generation completes.
   */
  private signDeliveryUrl(
    row: AttachmentRecord,
    options: AttachmentUrlOptions & { variant?: string },
  ): string {
    const params = new URLSearchParams()
    if (options.variant) params.set('variant', options.variant)
    // §4's allowlist still wins: the parameter can force `attachment`, never
    // `inline`.
    if (options.disposition) params.set('disposition', options.disposition)
    const query = params.size > 0 ? `?${params}` : ''
    // A stored name with a lone surrogate must not make encodeURIComponent throw.
    const path = `${this.delivery!.prefix}/${encodeURIComponent(row.id)}/${encodeURIComponent(wellFormed(row.name))}`
    return signUrl(`${path}${query}`, this.deliveryKeyring(), {
      expiresIn: options.expiresIn ?? this.urlExpiresIn,
    })
  }

  /**
   * Serve one delivery-route request (RFC 0015 §1). Every failure is the same
   * 404: invalid signature, expired URL, and unknown id stay indistinguishable.
   * Takes the raw `Request` so each parameter is re-read from the *same*
   * `URLSearchParams` parse the signature canonicalizes with; a route decoder
   * disagrees on malformed percent-encoding, a signed-URL rewrite primitive.
   */
  async handleDeliveryRequest(request: Request): Promise<Response> {
    const notFound = () =>
      new Response('Not Found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } })

    // Without delivery config this engine never signed anything; uniform 404.
    if (!this.delivery) return notFound()

    const url = new URL(request.url)
    const signedPart = `${url.pathname}${url.search}`
    if (!verifySignedUrl(signedPart, this.deliveryKeyring(), { requireExpiration: true })) {
      return notFound()
    }

    // Only URLs this engine signed reach here, so the decode cannot throw for
    // real traffic; the catch is defense in depth.
    let id: string
    try {
      id = decodeURIComponent(url.pathname.slice(this.delivery.prefix.length + 1).split('/')[0] ?? '')
    } catch {
      return notFound()
    }
    const variant = url.searchParams.get('variant') ?? undefined
    const forceAttachment = url.searchParams.get('disposition') === 'attachment'

    const raw = (await this.model.find(id)) as PlainObject | null
    if (!raw) return notFound()
    const row = this.toRecord(raw)

    // A valid signature proves the variant was declared when the URL was minted,
    // so variant state never 404s: resolveVariantTarget falls back (§1).
    const target = this.resolveVariantTarget(row, variant)

    // `expires` passed verification, so it is a plain integer in seconds.
    const remainingMs = Math.max(0, Number(url.searchParams.get('expires')) * 1000 - Date.now())

    const disposition = contentDispositionFor(target.contentType, forceAttachment, wellFormed(row.name))
    const disk = this.storage().disk(row.disk)
    const mode = this.serveModeFor(row.disk)
    // Fail closed at the comparison site: redirecting requires the driver's
    // *positive* presignedGet declaration whatever the configured mode.
    // `serve: 'redirect'` on a non-presigning disk would 302 to whatever
    // temporaryUrl() returns — LocalDriver's is the plain public URL, the exact
    // fail-open this route exists to close. It downgrades to proxy instead.
    const canPresign = disk.capabilities?.presignedGet === true
    if (mode === 'redirect' && !canPresign) {
      warnRedirectDowngradeOnce(row.disk)
    }
    const redirect = canPresign && mode !== 'proxy'

    if (redirect) {
      // Fixed short TTL: the inner credential only needs to survive one fetch.
      const inner = new Date(Date.now() + Math.min(remainingMs, INNER_PRESIGN_TTL_MS))
      const location = await disk.temporaryUrl(target.path, inner, {
        responseContentDisposition: disposition,
        responseContentType: target.contentType,
      })
      return new Response(null, {
        status: 302,
        headers: {
          Location: location,
          // The Location is a bearer credential.
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        },
      })
    }

    const etag = deliveryEtag(target.path, target.size, row.updatedAt)
    const headers: Record<string, string> = {
      'Content-Type': target.contentType,
      'Content-Disposition': disposition,
      'X-Content-Type-Options': 'nosniff',
      // Even if an inline type carries active content in some engine, it
      // executes with no origin.
      'Content-Security-Policy': 'sandbox',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': `private, max-age=${Math.floor(remainingMs / 1000)}`,
      ETag: etag,
    }

    // A 304 is reachable only when the client already holds the bytes, so no
    // storage check.
    if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers })
    }

    if (target.size != null) headers['Content-Length'] = String(target.size)

    // Hono dispatches HEAD through the GET handler and drops the body, so
    // without this branch every HEAD pays for the storage read. A HEAD 200 still
    // asserts existence, hence exists() rather than nothing.
    if (request.method === 'HEAD') {
      return (await disk.exists(target.path)) ? new Response(null, { headers }) : notFound()
    }

    const body = disk.getStream ? await disk.getStream(target.path) : await disk.get(target.path)
    // A row pointing at nothing surfaces as 404, like v1's loud url() failure.
    if (!body) return notFound()
    return new Response(body as BodyInit, { headers })
  }

  private async toData(row: AttachmentRecord, spec: AttachmentCollectionSpec): Promise<AttachmentData> {
    const viaRoute = this.usesDeliveryRoute(row)
    const originalUrl = await this.urlForRow(row, {})
    const variants: AttachmentData['variants'] = {}
    for (const name of Object.keys(spec.variants ?? {})) {
      const target = this.resolveVariantTarget(row, name)
      const entry = row.variants?.[name]
      // Not-ready variants fall back to the original so pages keep rendering. On
      // a delivery-route disk the route resolves at serve time; everywhere else
      // the fallback resolves here, reusing `originalUrl` byte for byte — one
      // temporaryUrl() call per row instead of one per pending variant.
      variants[name] = {
        url:
          viaRoute || target.ready ? await this.urlForRow(row, { variant: name }) : originalUrl,
        width: target.ready ? (entry?.width ?? null) : null,
        height: target.ready ? (entry?.height ?? null) : null,
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

let activeEngine: AttachmentEngine | null = null

/** Install the engine `configureAttachments()` built. Last call wins; `null` unconfigures (tests). */
export function setActiveAttachmentEngine(engine: AttachmentEngine | null): void {
  activeEngine = engine
}

/**
 * The active engine, or `null` when `configureAttachments()` has not run. The
 * delivery route resolves it per request so its registration stays
 * configuration-independent for bootless route tooling.
 */
export function getActiveAttachmentEngine(): AttachmentEngine | null {
  return activeEngine
}

/**
 * The delivery route's prefix and name: configured values when an engine is
 * active, defaults otherwise (bootless route tooling boots no providers). The
 * one place the defaults are applied outside the engine constructor.
 */
export function resolveDeliveryRoute(): { prefix: string; routeName: string } {
  return (
    activeEngine?.deliveryRoute ?? {
      prefix: DEFAULT_DELIVERY_PREFIX,
      routeName: DEFAULT_DELIVERY_ROUTE_NAME,
    }
  )
}

export function resolveAttachmentEngine(caller: string): AttachmentEngine {
  if (!activeEngine) {
    throw new Error(
      `${caller} requires attachments to be configured. Call configureAttachments({ table, storage, disk }) once at boot (e.g. in config/attachments.ts) before using the attachment statics.`,
    )
  }
  return activeEngine
}

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
  // No path-string form: it would be an arbitrary-file-read primitive (§6).
  throw new TypeError(
    'attach() accepts bytes only (File, Blob, or Uint8Array). Filesystem path strings are not supported.',
  )
}

/**
 * Filenames become part of the object key, so they must not steer it: no path
 * separators, no control characters, never empty or dot-only.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  // By code point, not code unit: a slice() landing inside a surrogate pair
  // leaves a lone surrogate that later throws in encodeURIComponent.
  const cleaned = Array.from(base.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .slice(0, 200)
    .join('')
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

function normalizeDiskDelivery(
  disks: Record<string, DiskDeliveryConfig>,
): Record<string, ResolvedDiskDelivery> {
  const normalized: Record<string, ResolvedDiskDelivery> = {}
  for (const [name, config] of Object.entries(disks)) {
    if (typeof config === 'string') {
      normalized[name] = { visibility: config, route: true, serve: 'auto' }
    } else {
      const serve = config.serve ?? 'auto'
      normalized[name] = {
        visibility: config.visibility,
        route: serve !== 'direct',
        serve: serve === 'direct' ? 'auto' : serve,
      }
    }
  }
  return normalized
}

function normalizeDeliveryPrefix(prefix: string): string {
  // Loop, not /\/+$/: the regex form backtracks polynomially on slash-heavy
  // input (same loop as @guren/server's trimTrailingSlashes).
  let end = prefix.length
  while (end > 0 && prefix.charCodeAt(end - 1) === 0x2f /* '/' */) {
    end--
  }
  const trimmed = prefix.slice(0, end)
  // A '//' start becomes an authority, '?'/'#' swallow the id and filename
  // segments, and whitespace never survives a real URL.
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || /[?#\s]/.test(trimmed)) {
    throw new Error(
      `configureAttachments: delivery.prefix must be a plain absolute path ('/attachments'-shaped), got '${prefix}'.`,
    )
  }
  return trimmed
}

/**
 * Content types allowed to render inline (RFC 0015 §4). Everything else, notably
 * image/svg+xml and text/html, is forced to `attachment`; nothing can force
 * `inline` for an unlisted type.
 */
const INLINE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'video/mp4',
  'audio/mpeg',
  'text/plain',
])

function contentDispositionFor(
  contentType: string,
  forceAttachment: boolean,
  filename: string,
): string {
  const kind = forceAttachment || !INLINE_CONTENT_TYPES.has(contentType) ? 'attachment' : 'inline'
  // Plain-ASCII fallback plus the RFC 5987 form for everything else.
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`
}

/**
 * `If-None-Match` per RFC 9110: a comma-separated list of entity tags (or
 * `*`), compared weakly — a `W/` prefix on either side does not break the
 * match.
 */
function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false
  const trimmed = header.trim()
  if (trimmed === '*') return true
  const strip = (value: string) => (value.startsWith('W/') ? value.slice(2) : value)
  const target = strip(etag)
  return trimmed.split(',').some((candidate) => strip(candidate.trim()) === target)
}

/**
 * Replace lone surrogates so `encodeURIComponent` cannot throw on a stored name
 * whose truncation split a pair. `String#toWellFormed` is ES2024 (Bun, Node ≥
 * 20); older runtimes fall through.
 */
function wellFormed(value: string): string {
  const candidate = value as string & { toWellFormed?: () => string }
  return typeof candidate.toWellFormed === 'function' ? candidate.toWellFormed() : value
}

const warnedRedirectDowngrades = new Set<string>()

function warnRedirectDowngradeOnce(diskName: string): void {
  if (warnedRedirectDowngrades.has(diskName)) return
  warnedRedirectDowngrades.add(diskName)
  console.warn(
    `[guren] Attachments disk '${diskName}' is configured serve: 'redirect' but its driver does not declare `
      + `capabilities.presignedGet — redirecting would hand out whatever temporaryUrl() returns, which on a `
      + `local disk is the plain public URL. Serving via proxy instead; fix the disk's serve mode or use a `
      + `presign-capable driver.`,
  )
}

/** RFC 5987 attr-char escaping: encodeURIComponent leaves !'()* unescaped. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * A validator over the *resolved object*, not the request: `id + variant` is no
 * byte identity, since a pending variant resolves to original bytes today and
 * variant bytes tomorrow. Resolved key + size cover that; `updatedAt` covers a
 * same-key rewrite with different bytes of the same length.
 */
function deliveryEtag(path: string, size: number | null, updatedAt: Date): string {
  const digest = createHash('sha256')
    .update(`${path}:${size ?? ''}:${updatedAt.getTime()}`)
    .digest('base64url')
    .slice(0, 20)
  return `"${digest}"`
}
