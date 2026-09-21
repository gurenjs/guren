import type { QueuedJob } from './types'

/**
 * Read a queued job out of a JSON message body. The dates are strings on the
 * wire, so a reader that skips them hands callers a `QueuedJob` whose date
 * fields are not dates.
 */
export function deserializeQueuedJob(body: string): QueuedJob {
  const raw = JSON.parse(body)
  return {
    ...raw,
    availableAt: new Date(raw.availableAt),
    createdAt: new Date(raw.createdAt),
    reservedAt: raw.reservedAt ? new Date(raw.reservedAt) : null,
  }
}
