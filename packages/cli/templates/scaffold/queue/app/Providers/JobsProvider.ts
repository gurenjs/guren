import { ServiceProvider, registerJob } from '@guren/core'
import { ProcessWelcomeSequenceJob } from '../Jobs/ProcessWelcomeSequenceJob.js'

// config/queue.ts binds the queue; this registers the jobs it runs.
export default class JobsProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    // Every booted process registers them, including a worker that dispatches
    // nothing itself: a queued message carries the job's name, not its class.
    registerJob(ProcessWelcomeSequenceJob)
  }
}
