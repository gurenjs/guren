/**
 * Type-level tests for the Attachable mixin's declaration inference (RFC 0013
 * §3). Compiled by the root `tsc --noEmit`; never executed.
 */
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core'
import { defineModel, SoftDeletes } from '@guren/orm'
import { Attachable, hasManyAttached, hasOneAttached } from '../src/attachments/index'
import type { AttachmentData, AttachmentRecord } from '../src/attachments/index'

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  views: integer('views').notNull(),
})

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    image: 'require',
    variants: { thumb: { width: 320 }, og: { width: 1200 } },
  }),
  images: hasManyAttached({ image: 'require' }),
  draftPdf: hasOneAttached(),
}) {}

declare const file: File
declare const record: { id: number; title: string; body: string; views: number }

export async function collectionNames() {
  await Post.attach(1, 'cover', file)
  await Post.attach(1, 'images', file)
  // @ts-expect-error 'covr' is not a declared collection
  await Post.attach(1, 'covr', file)
  // @ts-expect-error 'gallery' is not a declared collection
  await Post.detach(1, 'gallery')
  // @ts-expect-error 'covr' is not a declared collection
  await Post.attachmentUrl(1, 'covr')
}

export async function bytesOnly() {
  await Post.attach(1, 'cover', new Uint8Array([1, 2, 3]))
  await Post.attach(1, 'cover', new Blob(['x']))
  // @ts-expect-error path strings are not accepted anywhere in the API
  await Post.attach(1, 'cover', '/etc/passwd')
}

export async function detachKinds() {
  await Post.detach(1, 'images', 'attachment-id')
  await Post.detach(1, 'images')
  await Post.detach(1, 'cover')
  // @ts-expect-error a hasOne collection has no attachment id to select
  await Post.detach(1, 'cover', 'attachment-id')
}

export async function variantNames() {
  await Post.attachmentUrl(1, 'cover', { variant: 'thumb' })
  await Post.attachmentUrl(record, 'cover', { variant: 'og' })
  // @ts-expect-error 'tumb' is not a declared variant of cover
  await Post.attachmentUrl(1, 'cover', { variant: 'tumb' })
  // @ts-expect-error images declared no variants
  await Post.attachmentUrl(1, 'images', { variant: 'thumb' })
}

export async function withAttachmentsShapes() {
  const [loaded] = await Post.withAttachments([record], ['cover', 'images'])
  const cover: AttachmentData | null = loaded!.cover
  const images: AttachmentData[] = loaded!.images
  const title: string = loaded!.title
  void cover
  void images
  void title
  // @ts-expect-error draftPdf was not requested, so it is not on the result
  void loaded!.draftPdf
  // @ts-expect-error cover is nullable-single, not an array
  const wrong: AttachmentData[] = loaded!.cover
  void wrong
  // @ts-expect-error 'covr' is not a declared collection
  await Post.withAttachments([record], ['covr'])
}

export async function attachReturn() {
  const attached: AttachmentRecord = await Post.attach(1, 'cover', file)
  void attached
}

export class CollidingPost extends Attachable(defineModel(posts), {
  // @ts-expect-error 'title' is a column of posts — the attachment would shadow it
  title: hasOneAttached(),
}) {}

export class SoftPost extends SoftDeletes(
  Attachable(defineModel(posts), { cover: hasOneAttached() }),
) {}

export class AttachableSoftPost extends Attachable(SoftDeletes(defineModel(posts)), {
  cover: hasOneAttached(),
}) {}

export async function composed() {
  await SoftPost.attach(1, 'cover', file)
  await SoftPost.withTrashed()
  await AttachableSoftPost.attach(1, 'cover', file)
  await AttachableSoftPost.withTrashed()
  // @ts-expect-error typo still caught through the SoftDeletes wrapper
  await SoftPost.attach(1, 'covr', file)
}
