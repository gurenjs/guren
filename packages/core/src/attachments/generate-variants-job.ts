import { Job } from '@guren/server'
import {
  ATTACHMENTS_BINDING,
  resolveAttachmentEngine,
  type AttachmentEngine,
  type GenerateVariantsPayload,
} from './engine.js'

export type { GenerateVariantsPayload } from './engine.js'

/**
 * Queue job behind `attach(..., { queued: true })` (RFC 0013 Part 2): the
 * deferred full decode, opted-in HEIC conversion, and the declared variants.
 *
 * The worker is where the image work happens — point it at a runtime with an
 * image processor, or every variant settles as `unavailable`.
 */
export class GenerateVariantsJob extends Job<GenerateVariantsPayload> {
  /** Pinned: queued messages must survive identifier mangling and renames. */
  static override jobName = 'GenerateVariantsJob'

  /** The app whose queue the worker drains, which a worker serving two is not free to guess. */
  private engine(): AttachmentEngine {
    return this.makeOptional(ATTACHMENTS_BINDING) ?? resolveAttachmentEngine('GenerateVariantsJob')
  }

  async handle(payload: GenerateVariantsPayload): Promise<void> {
    await this.engine().generateVariants(payload)
  }

  /** After the last retry, stop `pending` variants looking in-flight forever. */
  async failed(payload: GenerateVariantsPayload, _error: Error): Promise<void> {
    try {
      await this.engine().markDeferredFailed(payload.attachmentId)
    } catch {
      // Unconfigured or unreachable here means there is nothing to settle.
    }
  }
}
