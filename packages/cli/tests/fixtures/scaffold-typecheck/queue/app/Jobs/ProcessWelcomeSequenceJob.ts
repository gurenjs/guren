// Companion for typechecking templates/scaffold/queue: what
// makeJob('ProcessWelcomeSequence') emits. Pinned to the builder by
// scaffold-output.test.ts, so a builder change fails there with
// instructions rather than silently drifting from this copy.
import { Job } from '@guren/core'

export interface ProcessWelcomeSequenceJobPayload {
  [key: string]: unknown
}

export class ProcessWelcomeSequenceJob extends Job<ProcessWelcomeSequenceJobPayload> {
  static override queue = 'default'
  static override maxAttempts = 3

  async handle(payload: ProcessWelcomeSequenceJobPayload): Promise<void> {
    void payload
  }

  async failed(payload: ProcessWelcomeSequenceJobPayload, error: Error): Promise<void> {
    void payload
    console.error('ProcessWelcomeSequenceJob failed:', error.message)
  }
}
