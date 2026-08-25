import type { Model } from '@guren/orm'
import {
  AttachmentEngine,
  setActiveAttachmentEngine,
  type ConfigureAttachmentsOptions,
} from './engine.js'

export type { ConfigureAttachmentsOptions } from './engine.js'

export interface ConfiguredAttachments {
  /**
   * A ready-made model bound to the app's `attachments` table, with
   * `morphTo('attachable', 'attachable')` pre-declared — for morph relations
   * (`Post.morphMany('attachments', Attachment, 'attachable')`) and advanced
   * queries. The app-local name lives in app namespace; the framework itself
   * exports no bare `Attachment` (it would collide with the mail /
   * notification / Slack attachment vocabulary).
   */
  Attachment: typeof Model
}

/**
 * Wire the attachments layer, once per app (the `DatabaseSessionStore`
 * precedent: the app owns the table, the framework returns the model).
 * The attachment statics on `Attachable` models resolve this configuration
 * lazily and throw a clear error when it was never called.
 *
 * @example
 * ```ts
 * // config/attachments.ts
 * import { configureAttachments } from '@guren/core'
 * import { attachments } from '@/db/schema'
 *
 * export const { Attachment } = configureAttachments({
 *   table: attachments,
 *   storage: () => container.make('storage'),
 *   disk: 'media',
 * })
 * ```
 */
export function configureAttachments(options: ConfigureAttachmentsOptions): ConfiguredAttachments {
  const engine = new AttachmentEngine(options)
  setActiveAttachmentEngine(engine)
  return { Attachment: engine.model }
}
