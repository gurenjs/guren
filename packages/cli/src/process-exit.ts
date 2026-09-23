/**
 * Ends the CLI process once everything it wrote has reached the OS. A command that
 * imported app code (a routes file, db/schema.ts) may leave a timer or client open
 * that nothing here can close, so returning from `run()` is not enough to exit.
 * Bun's `process.exit()` drops `process.stdout.write()` data still queued on a pipe
 * (measured on 1.3.14: 64 KB of 4 MB arrives), and neither `writableLength` nor an
 * empty write's callback reports that queue, so each real write's callback is counted.
 */

type Write = NodeJS.WriteStream['write']

let pending = 0
let settled: Array<() => void> = []
const tracked = new WeakSet<NodeJS.WriteStream>()

function release(): void {
  pending -= 1
  if (pending > 0) return
  const waiters = settled
  settled = []
  for (const resolve of waiters) resolve()
}

function track(stream: NodeJS.WriteStream): void {
  if (tracked.has(stream)) return
  tracked.add(stream)
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean
  stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown): boolean => {
    const done = typeof encoding === 'function' ? encoding : callback
    pending += 1
    const onWritten = (error?: Error | null): void => {
      release()
      if (typeof done === 'function') (done as (error?: Error | null) => void)(error)
    }
    return typeof encoding === 'function' || encoding === undefined
      ? write(chunk, onWritten)
      : write(chunk, encoding, onWritten)
  }) as Write
}

/** Counts stdout/stderr writes from here on; call it before anything is written. */
export function trackStdioWrites(): void {
  track(process.stdout)
  track(process.stderr)
}

/** Resolves once every tracked write has been handed to the OS. */
export function stdioFlushed(): Promise<void> {
  if (pending === 0) return Promise.resolve()
  return new Promise((resolve) => settled.push(resolve))
}

/**
 * Exits with `code`, or with `process.exitCode` when `code` is 0 — a command that
 * reports failure by setting `process.exitCode` and returning keeps that code.
 */
export async function exitWhenFlushed(code: number): Promise<never> {
  await stdioFlushed()
  process.exit(code !== 0 ? code : undefined)
}
