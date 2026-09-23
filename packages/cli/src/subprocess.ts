import { spawn } from 'node:child_process'

export interface CapturedRun {
  exitCode: number
  stdout: string
  stderr: string
  /** Set when the caller's `timeoutMs` killed the child; `exitCode` then says nothing. */
  timedOut?: true
}

export interface CapturedOptions {
  /** SIGKILL the child after this many milliseconds and resolve with `timedOut`. */
  timeoutMs?: number
  /** Laid over this process's environment. */
  env?: Readonly<Record<string, string>>
  /**
   * Run the child in its own process group, killed whole on timeout, on its exit,
   * and on SIGINT/SIGTERM/SIGHUP here. Its stdin is a pipe held open for the run: a
   * child that kills its group when it ends (`introspect-child`) outlives no death
   * of this process, SIGKILL included. POSIX only; elsewhere the child alone is killed.
   */
  processGroup?: boolean
}

const FORWARDED_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** A subprocess run to completion with its output captured. `command[0]` is the executable. */
export type CapturedExec = (command: string[], cwd: string, options?: CapturedOptions) => Promise<CapturedRun>

/** The Bun that is running this process, or a `bun` on PATH under Node. */
export function bunExecutable(): string {
  return process.versions.bun ? process.execPath : 'bun'
}

export const runCaptured: CapturedExec = (command, cwd, options) =>
  new Promise((resolvePromise, rejectPromise) => {
    const [executable, ...args] = command
    if (!executable) {
      rejectPromise(new Error('empty command'))
      return
    }
    const grouped = Boolean(options?.processGroup) && process.platform !== 'win32'
    // Colour codes would end up inside findings an agent reads back.
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options?.env },
      stdio: [options?.processGroup ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: grouped,
    })
    // Both are piped above; the conditional stdin only widens the inferred type.
    const out = child.stdout!
    const err = child.stderr!
    const kill = (): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        // Already gone: the child leads its group, so an empty group means it exited too.
      }
    }
    // A detached group is outside this terminal's foreground group, which Ctrl+C signals.
    const forward = (signal: NodeJS.Signals): void => {
      kill()
      releaseSignals()
      process.kill(process.pid, signal)
    }
    const releaseSignals = (): void => {
      process.off('exit', kill)
      for (const signal of FORWARDED_SIGNALS) process.off(signal, forward)
    }
    if (grouped) {
      process.once('exit', kill)
      for (const signal of FORWARDED_SIGNALS) process.once(signal, forward)
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      releaseSignals()
      complete()
    }
    const settle = (run: CapturedRun): void => finish(() => resolvePromise(run))
    // SIGKILL outright (a child ignoring SIGTERM would outlive the CLI's own
    // exit), and settle now rather than on `close`: a grandchild holding the
    // pipes would otherwise keep `close` from firing until it finishes.
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            kill()
            out.destroy()
            err.destroy()
            settle({ exitCode: 1, stdout, stderr, timedOut: true })
          }, options.timeoutMs)
    out.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    err.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => finish(() => rejectPromise(error)))
    // What the child left behind would hold the pipes open, keeping `close` from firing.
    if (grouped) child.on('exit', kill)
    child.on('close', (code) => settle({ exitCode: code ?? 1, stdout, stderr }))
  })
