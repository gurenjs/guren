import { Job } from '@guren/server'
import { resolveAttachmentEngine, type GenerateVariantsPayload } from './engine.js'

export type { GenerateVariantsPayload } from './engine.js'

/**
 * Queue job behind `attach(..., { queued: true })` (RFC 0013 Part 2): runs
 * the deferred full decode, converts HEIC originals where the collection
 * opted in, and generates the declared variants, flipping their `pending`
 * status records to `ready`/`failed`.
 *
 * `configureAttachments()` registers this job, so any worker process that
 * boots the app's config can process it. The worker is where the image
 * work happens — point it at a runtime with an image processor (Bun with
 * `Bun.Image`, or a custom `configureAttachments({ processor })`), or every
 * variant settles as `unavailable`.
 */
export class GenerateVariantsJob extends Job<GenerateVariantsPayload> {
  /**
   * Pinned wire name: queued messages must survive bundler identifier
   * mangling and any future rename of this class.
   */
  static override jobName = 'GenerateVariantsJob'

  async handle(payload: GenerateVariantsPayload): Promise<void> {
    await resolveAttachmentEngine('GenerateVariantsJob').generateVariants(payload)
  }

  /**
   * After the last retry, stop `pending` variants from looking in-flight
   * forever — their URLs already fall back to the original either way.
   */
  async failed(payload: GenerateVariantsPayload, _error: Error): Promise<void> {
    try {
      await resolveAttachmentEngine('GenerateVariantsJob').markDeferredFailed(payload.attachmentId)
    } catch {
      // Unconfigured or unreachable here means there is nothing to settle.
    }
  }
}
