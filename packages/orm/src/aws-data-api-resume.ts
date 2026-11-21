export interface AwsDataApiResumeRetryOptions {
  /** No retry starts later than this many milliseconds after the first try. 0 retries nothing. Default 60000. */
  timeoutMs?: number
  /** Longest wait between two tries, in milliseconds, above 0. Waits start at 1 s and double. Default 5000. */
  maxDelayMs?: number
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_DELAY_MS = 5_000
const FIRST_DELAY_MS = 1_000

interface DataApiClient {
  send?: (...args: unknown[]) => unknown
}

// Matched by name so this module never imports the SDK. The Data API cancels the
// call that wakes a paused cluster, so retrying it cannot run a statement twice.
export function isDatabaseResuming(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'DatabaseResumingException'
}

function milliseconds(name: string, value: number, allowZero: boolean): number {
  // NaN (a `Number()` of an unset variable) would never reach the deadline and would wait 0 ms between tries.
  if (!Number.isFinite(value) || value < 0 || (value === 0 && !allowZero)) {
    const range = allowZero ? '0 or more' : 'above 0'
    throw new Error(`createAwsDataApiDatabase(): resumeRetry.${name} must be a finite number of milliseconds, ${range} (received ${value}).`)
  }
  return value
}

/**
 * Returns a function that replaces a client's `send` with one retrying a call
 * the Data API cancelled because the cluster was paused. Every other error,
 * `StatementTimeoutException` included, is rethrown at once: only the resuming
 * error says nothing ran. Options are checked here, before any client exists.
 */
export function createResumeRetry(options: AwsDataApiResumeRetryOptions = {}): (client: DataApiClient) => void {
  const timeoutMs = milliseconds('timeoutMs', options.timeoutMs ?? DEFAULT_TIMEOUT_MS, true)
  const maxDelayMs = milliseconds('maxDelayMs', options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, false)
  // One line per pause across every client of the factory: a cold start wakes the cluster with several calls at once.
  let announced = false

  async function sendWithRetry(client: DataApiClient, send: NonNullable<DataApiClient['send']>, args: unknown[]): Promise<unknown> {
    const startedAt = performance.now()
    let delay = Math.min(FIRST_DELAY_MS, maxDelayMs)

    for (;;) {
      try {
        const result = await send.apply(client, args)
        announced = false
        return result
      } catch (error) {
        const remaining = timeoutMs - (performance.now() - startedAt)
        if (!isDatabaseResuming(error) || remaining <= 0) {
          throw error
        }

        if (!announced) {
          announced = true
          console.warn(
            `[guren/orm] The Aurora cluster is resuming from a pause. Retrying the Data API call for up to ${Math.ceil(timeoutMs / 1000)}s.`,
          )
        }

        await new Promise((done) => setTimeout(done, Math.min(delay, remaining)))
        delay = Math.min(delay * 2, maxDelayMs)
      }
    }
  }

  return (client) => {
    const send = client.send
    if (typeof send !== 'function') {
      return
    }

    client.send = (...args: unknown[]): unknown => {
      // The callback form returns nothing to await, so it is passed through as it is.
      if (typeof args[args.length - 1] === 'function') {
        return send.apply(client, args)
      }
      return sendWithRetry(client, send, args)
    }
  }
}
