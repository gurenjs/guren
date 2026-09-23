/**
 * Bun's `process.exit()` drops `process.stdout.write()` data still queued on a slow
 * pipe (measured on 1.3.14 and 1.4.2: 64 KB of 4 MB arrives), and neither
 * `writableLength` nor an empty write's callback reports that queue, so each real
 * write's callback is counted and the exit waits for the count to reach zero.
 */

type WriteWithCallback = (chunk: unknown, encoding: unknown, callback: (error?: Error | null) => void) => boolean

let pending = 0
let onIdle: (() => void) | undefined

function track(stream: NodeJS.WriteStream): void {
  const write = stream.write.bind(stream) as WriteWithCallback
  stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === 'function' ? encoding : callback
    pending += 1
    return write(chunk, typeof encoding === 'function' ? undefined : encoding, (error) => {
      pending -= 1
      if (pending === 0) onIdle?.()
      if (typeof done === 'function') (done as (error?: Error | null) => void)(error)
    })
  }) as NodeJS.WriteStream['write']
}

/** Counts stdout/stderr writes from here on; earlier writes are not awaited. */
export function trackStdioWrites(): void {
  track(process.stdout)
  track(process.stderr)
}

/**
 * Exits once every tracked write has reached the OS, with `code`, or with
 * `process.exitCode` when `code` is 0: a command that reports failure by setting
 * `process.exitCode` and returning keeps that code.
 */
export async function exitWhenFlushed(code: number): Promise<never> {
  if (pending > 0) await new Promise<void>((resolve) => (onIdle = resolve))
  process.exit(code !== 0 ? code : undefined)
}
