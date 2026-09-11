import { Job, getQueueDriver, registerJob } from '../queue/Job'
import { encodeEventData } from './serialize'
import type { QueueEventDispatcher } from './types'

interface QueuedEventPayload {
  queue: string
  eventName: string
  /** The event's own enumerable fields; `EventManager.handleQueued()` rebuilds the instance. */
  event: Record<string, unknown>
  /** Which listener on that queue this message is for; see `EventManager.handleQueued()`. */
  listenerSeq?: number
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
      payload.listenerSeq,
    )
  }

  async failed(payload: QueuedEventPayload, error: Error): Promise<void> {
    await this.make('events').failedQueued(
      payload.queue,
      payload.eventName,
      payload.event,
      payload.listenerSeq,
      error,
    )
  }
}

/**
 * The dispatcher `EventServiceProvider` installs at boot. Registers the carrier
 * job as well, which is what lets a worker booting the same app resolve the
 * message back.
 *
 * Resolves false when no driver is reachable rather than letting
 * `Job.dispatch()` throw: it is installed before the app's queue is bound, and
 * an emit it cannot queue runs the listener inline.
 */
export function createQueueEventDispatcher(): QueueEventDispatcher {
  registerJob(QueuedEventJob)
  return async (queue, eventName, event, listenerSeq) => {
    if (getQueueDriver() === null) return false
    await QueuedEventJob.dispatch(
      { queue, eventName, event: encodeEventData(event), listenerSeq },
      { queue },
    )
    return true
  }
}
