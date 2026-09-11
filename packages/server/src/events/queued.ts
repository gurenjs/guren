import { Job, registerJob } from '../queue/Job'
import { encodeEventData } from './serialize'
import type { QueueEventDispatcher } from './types'

interface QueuedEventPayload {
  queue: string
  eventName: string
  /** The event's own enumerable fields; `EventManager.handleQueued()` rebuilds the instance. */
  event: Record<string, unknown>
  /** Which listener on that queue this message is for; see `EventManager.handleQueued()`. */
  listenerIndex?: number
}

/**
 * Carries a queued emit to the worker, which runs the listener through the
 * app's `events` binding. One message per queued listener, so a listener that
 * throws is retried on its own rather than re-running the ones beside it.
 */
class QueuedEventJob extends Job<QueuedEventPayload> {
  static jobName = 'QueuedEventJob'

  async handle(payload: QueuedEventPayload): Promise<void> {
    await this.make('events').handleQueued(
      payload.queue,
      payload.eventName,
      payload.event,
      payload.listenerIndex,
    )
  }
}

/**
 * The dispatcher `EventServiceProvider` installs at boot. Registers the carrier
 * job as well, which is what lets a worker booting the same app resolve the
 * message back.
 */
export function createQueueEventDispatcher(): QueueEventDispatcher {
  registerJob(QueuedEventJob)
  return async (queue, eventName, event, listenerIndex) => {
    await QueuedEventJob.dispatch(
      { queue, eventName, event: encodeEventData(event), listenerIndex },
      { queue },
    )
  }
}
