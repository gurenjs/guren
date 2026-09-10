import { Job, registerJob } from '../queue/Job'
import type { QueueEventDispatcher } from './types'

interface QueuedEventPayload {
  queue: string
  eventName: string
  /** The event's own enumerable fields; `EventManager.handleQueued()` rebuilds the instance. */
  event: Record<string, unknown>
}

/**
 * Carries a queued emit to the worker, which runs the listeners for that
 * event and queue through the app's `events` binding. One message per queue
 * per emit, so the worker process must register the same listeners.
 */
class QueuedEventJob extends Job<QueuedEventPayload> {
  static jobName = 'QueuedEventJob'

  async handle(payload: QueuedEventPayload): Promise<void> {
    await this.make('events').handleQueued(payload.queue, payload.eventName, payload.event)
  }
}

/**
 * The dispatcher `EventServiceProvider` installs when the app binds a `queue`
 * manager. Registers the carrier job as well, which is what lets a worker
 * booting the same app resolve the message back.
 */
export function createQueueEventDispatcher(): QueueEventDispatcher {
  registerJob(QueuedEventJob)
  return async (queue, eventName, event) => {
    await QueuedEventJob.dispatch({ queue, eventName, event: { ...event } }, { queue })
  }
}
