import { ServiceProvider, MemoryDriver, SyncDriver, createQueueManager, registerJob, type QueueManager } from '@guren/core'
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
    // Register job classes before the driver so sync dispatches can resolve them.
    registerJob(ProcessWelcomeSequenceJob)
    const queue = this.container.make<QueueManager>('queue')
    queue.driver()
  }
}
