/**
 * Public types for the attachments layer (RFC 0013).
 *
 * One table, one service, one processor interface: attachments ride the ORM's
 * polymorphic `attachable` morph convention, bytes live on a `StorageManager`
 * disk, and image work happens behind {@link ImageProcessor}.
 */

/**
 * A named image variant specification, declared on the model via
 * `hasOneAttached({ variants: { thumb: { width: 320 } } })`.
 *
 * `fit` is limited to what `Bun.Image` actually supports (`'fill'` and
 * `'inside'`); `'cover'` is reserved for a future, non-breaking addition.
 */
export interface VariantSpec {
  width?: number
  height?: number
  /**
   * How the image is fitted when both dimensions are given.
   * @default 'inside'
   */
  fit?: 'fill' | 'inside'
  /** Output format. Defaults to the source format. */
  format?: 'jpeg' | 'png' | 'webp' | 'avif'
  /** Encoder quality (1-100) for lossy formats. */
  quality?: number
}

/**
 * Per-variant status entry stored in the attachment row's `variants` JSON
 * column. Every *declared* variant gets an entry at attach time — recording
 * declared names, not just generated ones, is what lets `attachmentUrl()`
 * distinguish "not yet generated" (fall back to the original) from "never
 * declared" (throw) after a reload.
 *
 * - `pending`  — generation is queued (queued generation ships in a later
 *   release; the status exists so rows stay forward-compatible)
 * - `ready`    — the variant object exists at `path`
 * - `failed`   — generation was attempted and failed
 * - `unavailable` — the runtime has no image processor
 */
export interface AttachmentVariantRecord {
  status: 'pending' | 'ready' | 'failed' | 'unavailable'
  /** Object key of the generated variant (status `ready`). */
  path?: string
  width?: number
  height?: number
  format?: 'jpeg' | 'png' | 'webp' | 'avif'
  /** Encoded size in bytes. */
  size?: number
}

/**
 * A row of the `attachments` table, as returned by the attachment statics.
 */
export interface AttachmentRecord {
  /** ULID — sortable, unguessable object-key prefix. */
  id: string
  /** Model class name (the ORM's `Model.morphMap` convention). */
  attachableType: string
  /** Owning record's primary key, stored as text (covers int and uuid PKs). */
  attachableId: string
  /** Collection name declared on the model (`'cover'`, `'images'`, ...). */
  collection: string
  /** StorageManager disk name the bytes live on. */
  disk: string
  /** Object key of the original. */
  path: string
  /** Original client filename (sanitized). */
  name: string
  contentType: string
  /** Size of the stored original in bytes. */
  size: number
  /** Pixel width — `null` for non-images and undecoded uploads. */
  width: number | null
  height: number | null
  /** Per-declared-variant status records, `null` when none were declared. */
  variants: Record<string, AttachmentVariantRecord> | null
  /** ThumbHash LQIP data URL — images only, `null` without a processor. */
  placeholder: string | null
  createdAt: Date
  updatedAt: Date
}

/**
 * The resource-facing shape returned by `withAttachments()`, ready for
 * `JsonResource.toArray()` so pages can carry typed attachment props.
 *
 * `variants` has an entry for every *declared* variant name; a variant that
 * is not `ready` yet falls back to the original's URL, so pages keep
 * rendering (the `placeholder` LQIP covers the perceived-latency gap).
 */
export interface AttachmentData {
  id: string
  collection: string
  name: string
  contentType: string
  size: number
  width: number | null
  height: number | null
  url: string
  placeholder: string | null
  variants: Record<string, { url: string; width: number | null; height: number | null }>
}

/**
 * Image processing behind the attachments pipeline.
 *
 * The default implementation wraps `Bun.Image` and is resolved only when the
 * runtime has it; apps on other runtimes may inject their own (e.g. a
 * sharp-backed one) via `configureAttachments({ processor })`.
 *
 * Implementations signal an OS-level codec gap by throwing an error whose
 * `code` is `'ERR_IMAGE_FORMAT_UNSUPPORTED'` — format support is a runtime
 * property (OS codecs), never a static table, so that error code is the only
 * authority the pipeline branches on.
 */
export interface ImageProcessor {
  /**
   * Full decode: validates the bytes, enforces `maxPixels`, reports
   * dimensions. Header sniffing is *not* validation — truncated files pass
   * it — so implementations must decode pixels before resolving.
   */
  probe(
    input: Uint8Array,
    limits: { maxPixels: number },
  ): Promise<{ width: number; height: number; format: string; placeholder?: string }>

  /** Generate one variant: resize per the spec and encode. */
  process(
    input: Uint8Array,
    spec: VariantSpec,
  ): Promise<{ bytes: Uint8Array; width: number; height: number; format: string }>
}

/**
 * What an attachment collection accepts as image input.
 *
 * - unset      — opaque bytes: no image pipeline at all, `width`/`height`/
 *   `placeholder` stay `null` (a `draftPdf` collection)
 * - `'allow'`  — images are decoded and measured when recognized; anything
 *   else is stored as opaque bytes
 * - `'require'`— input must be a decodable image; non-images are rejected
 *   with a 422 `ValidationException`
 * - `'forbid'` — inputs that sniff as images are rejected with 422
 */
export type ImagePolicy = 'forbid' | 'allow' | 'require'

/**
 * The bytes-only attach input. Filesystem path strings are deliberately not
 * accepted anywhere in this API: `Bun.Image`'s path form is an
 * arbitrary-file-read primitive if a user-influenced string ever reaches it,
 * so the pipeline never exposes the shape at all.
 */
export type AttachmentSource = File | Blob | Uint8Array
