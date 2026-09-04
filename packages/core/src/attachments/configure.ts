import type { Model } from '@guren/orm'
import { registerJob } from '@guren/server'
import {
  AttachmentEngine,
  setActiveAttachmentEngine,
  type ConfigureAttachmentsOptions,
} from './engine.js'
import { GenerateVariantsJob } from './generate-variants-job.js'

export type { ConfigureAttachmentsOptions } from './engine.js'

export interface ConfiguredAttachments {
  /**
   * A model bound to the app's `attachments` table with
   * `morphTo('attachable', 'attachable')` pre-declared. The framework exports no
   * bare `Attachment`: it would collide with the mail / notification / Slack
   * attachment vocabulary.
   */
  Attachment: typeof Model
}

/**
 * Wire the attachments layer, once per app: the app owns the table, the
 * framework returns the model. `Attachable` statics resolve this lazily and
 * throw a clear error when it was never called.
 *
 * @example
 * ```ts
 * export const { Attachment } = configureAttachments({
 *   table: attachments,
 *   storage: () => container.make('storage'),
 *   disk: 'media',
 * })
 * ```
 */
export function configureAttachments(options: ConfigureAttachmentsOptions): ConfiguredAttachments {
  const engine = new AttachmentEngine(options)
  // Wired here rather than inside the engine so engine.ts never imports the
  // job module (which imports engine.ts for the active-engine lookup).
  engine.setJobDispatcher((payload) => GenerateVariantsJob.dispatch(payload))
  // At configure time, so any worker booting the app's config can resolve
  // queued GenerateVariantsJob messages.
  registerJob(GenerateVariantsJob)
  setActiveAttachmentEngine(engine)
  return { Attachment: engine.model }
}
