/**
 * Public types for the attachments layer (RFC 0013): attachments ride the ORM's
 * polymorphic `attachable` morph convention, bytes live on a `StorageManager`
 * disk, and image work happens behind {@link ImageProcessor}.
 */

/**
 * A named image variant specification. `fit` is limited to what `Bun.Image`
 * supports; `'cover'` is reserved for a future, non-breaking addition.
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
 * Per-variant status entry in the row's `variants` JSON column. Every *declared*
 * variant gets an entry at attach time, which is what lets `attachmentUrl()`
 * tell "not yet generated" (fall back) from "never declared" (throw).
 *
 * `pending` is queued generation, `ready` means the object exists at `path`,
 * `failed` was attempted, `unavailable` means the runtime has no processor.
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

/** A row of the `attachments` table, as returned by the attachment statics. */
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
 * The resource-facing shape returned by `withAttachments()`. `variants` has an
 * entry for every *declared* variant name; one that is not `ready` yet falls
 * back to the original's URL, so pages keep rendering.
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
 * Image processing behind the attachments pipeline. The default wraps
 * `Bun.Image`; other runtimes inject their own via
 * `configureAttachments({ processor })`.
 *
 * Implementations signal an OS-level codec gap by throwing with `code ===
 * 'ERR_IMAGE_FORMAT_UNSUPPORTED'` — format support is a runtime property, so
 * that code is the only authority the pipeline branches on.
 */
export interface ImageProcessor {
  /**
   * Full decode: validates the bytes, enforces `maxPixels`, reports dimensions.
   * Header sniffing is *not* validation (truncated files pass it), so
   * implementations must decode pixels before resolving.
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
 * What an attachment collection accepts as image input. Unset means opaque
 * bytes with no image pipeline; `'allow'` decodes recognized images and stores
 * anything else opaquely; `'require'` and `'forbid'` reject with a 422.
 */
export type ImagePolicy = 'forbid' | 'allow' | 'require'

/**
 * The bytes-only attach input. Filesystem path strings are never accepted:
 * `Bun.Image`'s path form is an arbitrary-file-read primitive once a
 * user-influenced string reaches it.
 */
export type AttachmentSource = File | Blob | Uint8Array
