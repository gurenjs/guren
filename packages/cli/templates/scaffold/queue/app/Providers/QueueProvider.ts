import { ServiceProvider, MemoryDriver, SyncDriver, createQueueManager, registerJob } from '@guren/core'
import { ProcessWelcomeSequenceJob } from '../Jobs/ProcessWelcomeSequenceJob.js'

export default class QueueProvider extends ServiceProvider {
  register(): void {
    const queue = createQueueManager({
      // QUEUE_CONNECTION=sync executes jobs inline on dispatch (default,
      // no worker process needed); 'memory' queues them for a Worker.
      default: process.env.QUEUE_CONNECTION === 'memory' ? 'memory' : 'sync',
      drivers: {
        sync: () => new SyncDriver(),
        memory: () => new MemoryDriver(),
      },
    })

    this.container.instance('queue', queue)
  }

  boot(): void {
    // Every booted process registers them, including a worker that dispatches
    // nothing itself: a queued message carries the job's name, not its class.
    registerJob(ProcessWelcomeSequenceJob)
  }
}
