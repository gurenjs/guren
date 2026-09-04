import type { ImagePolicy, VariantSpec } from './types.js'

/**
 * How HEIC/HEIF input is handled. Defaults to `'reject'` (415) because HEIC
 * decoding depends on OS codecs — it works on macOS dev machines and fails on
 * Linux production. `'convert'` opts into decode-and-convert to JPEG, still
 * answering 415 when the runtime cannot decode HEIC.
 */
export type HeicPolicy = 'reject' | 'convert'

export interface AttachedCollectionOptions<V extends string = never> {
  /**
   * Image handling for this collection. Defaults to `'require'` when
   * `variants` are declared (variant generation needs a decodable image)
   * and to opaque-bytes handling otherwise.
   */
  image?: ImagePolicy
  accepts?: { heic?: HeicPolicy }
  /** Named variants, generated at attach time (or recorded as unavailable). */
  variants?: Record<V, VariantSpec>
}

/**
 * One collection's declaration as stored on the model's `static attachments`.
 * The generics carry the collection kind and the declared variant names into
 * the mixin's compile-time checks.
 */
export interface AttachmentCollectionSpec<
  TKind extends 'one' | 'many' = 'one' | 'many',
  V extends string = string,
> {
  kind: TKind
  image?: ImagePolicy
  accepts?: { heic?: HeicPolicy }
  variants?: Record<V, VariantSpec>
}

/** The declaration object passed into `Attachable(Base, declaration)`. */
export type AttachmentsDeclaration = Record<string, AttachmentCollectionSpec<'one' | 'many', string>>

function buildSpec<TKind extends 'one' | 'many', V extends string>(
  kind: TKind,
  options: AttachedCollectionOptions<V>,
): AttachmentCollectionSpec<TKind, V> {
  const hasVariants = options.variants !== undefined && Object.keys(options.variants).length > 0
  if (options.image === 'forbid' && hasVariants) {
    throw new Error(
      "Attachment collections with variants cannot set image: 'forbid' — variant generation requires decodable image input.",
    )
  }
  const image = options.image ?? (hasVariants ? 'require' : undefined)
  const spec: AttachmentCollectionSpec<TKind, V> = { kind }
  if (image !== undefined) spec.image = image
  if (options.accepts !== undefined) spec.accepts = options.accepts
  if (options.variants !== undefined) spec.variants = options.variants
  return spec
}

/**
 * Declare a single-attachment collection (`attach` replaces the previous
 * attachment, purging its row and objects). Called with no options the bytes
 * stay opaque: width/height/placeholder are null.
 */
export function hasOneAttached<const V extends string = never>(
  options: AttachedCollectionOptions<V> = {},
): AttachmentCollectionSpec<'one', V> {
  return buildSpec('one', options)
}

/** Declare a multi-attachment collection (`attach` appends). */
export function hasManyAttached<const V extends string = never>(
  options: AttachedCollectionOptions<V> = {},
): AttachmentCollectionSpec<'many', V> {
  return buildSpec('many', options)
}
