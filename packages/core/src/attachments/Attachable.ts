import type { Model, PlainObject } from '@guren/orm'
import type { AttachmentsDeclaration } from './declaration.js'
import { resolveAttachmentEngine, type AttachOptions, type AttachmentUrlOptions } from './engine.js'
import type { AttachmentData, AttachmentRecord, AttachmentSource } from './types.js'

/** A record id accepted by the attachment statics (int and uuid/text PKs). */
export type AttachableRecordId = string | number

/**
 * Deliberately minimal: a tighter bound would become the contextual type of the
 * `hasOneAttached()` / `hasManyAttached()` calls and widen their variant-name
 * parameter to `string`, disabling every variant-name check.
 */
type DeclarationShape = Record<string, { kind: 'one' | 'many' }>

/** The variant names declared on one collection spec. */
type VariantNamesOf<TSpec> = TSpec extends { variants?: infer TVariants }
  ? keyof NonNullable<TVariants> & string
  : never

/** `hasOne` loads as nullable-single, `hasMany` as an array. */
type AttachedProps<TDecl, K extends keyof TDecl> = {
  [P in K]: TDecl[P] extends { kind: 'many' } ? AttachmentData[] : AttachmentData | null
}

/** `detach` takes an attachment id only on a `hasMany` collection. */
type DetachRest<TSpec> = TSpec extends { kind: 'many' } ? [attachmentId?: string] : []

/**
 * Rejects declaration keys that shadow a real column of the base model's table
 * (the attachment would hide it at `withAttachments` time). A base whose record
 * type is untyped is exempt.
 */
type CollisionFreeDeclaration<TBase extends typeof Model, TDecl> =
  string extends keyof TBase['recordType'] & string
    ? unknown
    : { [K in Extract<keyof TDecl, keyof TBase['recordType']>]: never }

/**
 * The statics the `Attachable` mixin adds, all delegating to the engine wired by
 * `configureAttachments()`. Every collection argument is `keyof` the
 * declaration, so typos and undeclared variant names are compile errors.
 */
// oxlint-disable-next-line no-unused-vars -- phantom type parameter, kept because it is part of the public signature
export interface AttachableStatic<TBase extends typeof Model, TDecl extends DeclarationShape> {
  /** The declaration, statically readable (this is what `guren check` and codegen read). */
  readonly attachments: TDecl

  /**
   * Store bytes as an attachment on `collection`. `source` is bytes only — path
   * strings are never accepted. `hasOne` replaces the previous attachment (row
   * and objects purged); `hasMany` appends. Validation and variant specs come
   * from the declaration, not the call site.
   */
  attach<K extends keyof TDecl & string>(
    recordId: AttachableRecordId,
    collection: K,
    source: AttachmentSource,
    options?: AttachOptions,
  ): Promise<AttachmentRecord>

  /**
   * Remove attachment rows and their stored objects. On a `hasMany`
   * collection an `attachmentId` narrows it to one attachment; omitted, the
   * whole collection is detached.
   */
  detach<K extends keyof TDecl & string>(
    recordId: AttachableRecordId,
    collection: K,
    // NoInfer: only the collection argument may pick K — otherwise this
    // parameter would widen K to a union that happens to admit the call.
    ...attachmentId: DetachRest<TDecl[NoInfer<K>]>
  ): Promise<void>

  /**
   * Batch-load attachments for a page of records (one indexed query per
   * call), attaching each requested collection as a typed property:
   * `hasOne` → `AttachmentData | null`, `hasMany` → `AttachmentData[]`.
   */
  withAttachments<TRecord extends { id: string | number }, K extends keyof TDecl & string>(
    records: readonly TRecord[],
    names: readonly K[],
  ): Promise<Array<TRecord & AttachedProps<TDecl, K>>>

  /**
   * URL for a collection's attachment: `disk.url()` on public disks; on private
   * ones a signed delivery-route URL when `delivery` is configured (RFC 0015),
   * else `disk.temporaryUrl()`. A declared-but-not-ready variant falls back to
   * the original; an undeclared variant name throws. `expiresIn` is in ms.
   * Returns `null` when nothing is attached.
   */
  attachmentUrl<K extends keyof TDecl & string>(
    record: PlainObject | AttachableRecordId,
    collection: K,
    // NoInfer: without it, `variant` becomes a second inference site for K
    // and widens it to whichever union of collections admits the name.
    options?: AttachmentUrlOptions & { variant?: VariantNamesOf<TDecl[NoInfer<K>]> },
  ): Promise<string | null>

  /**
   * Remove every attachment of a record, objects first, rows after. Call it from
   * destroy actions: model delete hooks are not a reliable purge trigger.
   */
  purgeAttachments(recordId: AttachableRecordId): Promise<void>
}

/**
 * Mixin that declares attachment collections on a model (RFC 0013). The
 * declaration is a static argument in the heritage clause, so it stays
 * statically readable to `guren check` and `guren context` while its collection
 * names, kinds, and variant names are inferred as compile-time facts.
 *
 * @example
 * export class Post extends Attachable(defineModel(posts), {
 *   cover: hasOneAttached({ image: 'require', variants: { thumb: { width: 320 } } }),
 *   images: hasManyAttached({ image: 'require' }),
 * }) {}
 */
export function Attachable<
  TBase extends typeof Model,
  const TDecl extends DeclarationShape,
>(
  Base: TBase,
  declaration: TDecl & CollisionFreeDeclaration<TBase, TDecl>,
): TBase & AttachableStatic<TBase, TDecl> {
  const AttachableModel = class extends (Base as typeof Model) {} as unknown as TBase &
    AttachableStatic<TBase, TDecl>

  const decl = declaration as unknown as AttachmentsDeclaration

  // Assigned untyped: `AttachableStatic` declares these with generics the
  // runtime bodies cannot restate. `this` is the model class the static was
  // called on, so subclasses report their own name in errors.
  Object.assign(AttachableModel, {
    attachments: declaration,

    attach(
      this: typeof Model,
      recordId: AttachableRecordId,
      collection: string,
      source: AttachmentSource,
      options?: AttachOptions,
    ) {
      const engine = resolveAttachmentEngine(`${this.name}.attach()`)
      return engine.attach(this, decl, recordId, collection, source, options)
    },

    detach(this: typeof Model, recordId: AttachableRecordId, collection: string, attachmentId?: string) {
      const engine = resolveAttachmentEngine(`${this.name}.detach()`)
      return engine.detach(this, decl, recordId, collection, attachmentId)
    },

    withAttachments(this: typeof Model, records: readonly PlainObject[], names: readonly string[]) {
      const engine = resolveAttachmentEngine(`${this.name}.withAttachments()`)
      return engine.withAttachments(this, decl, records, names)
    },

    attachmentUrl(
      this: typeof Model,
      record: PlainObject | AttachableRecordId,
      collection: string,
      options?: AttachmentUrlOptions & { variant?: string },
    ) {
      const engine = resolveAttachmentEngine(`${this.name}.attachmentUrl()`)
      return engine.attachmentUrl(this, decl, record, collection, options)
    },

    purgeAttachments(this: typeof Model, recordId: AttachableRecordId) {
      const engine = resolveAttachmentEngine(`${this.name}.purgeAttachments()`)
      return engine.purgeAttachments(this, recordId)
    },
  })

  return AttachableModel
}
