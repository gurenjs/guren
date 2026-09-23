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
   * Run the child in its own process group, and kill the whole group on timeout
   * or when this process exits: what the child spawned (an app's `register()`
   * starting a helper) goes with it. POSIX only; elsewhere the child alone is killed.
   */
  processGroup?: true
}

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
    const grouped = options?.processGroup === true && process.platform !== 'win32'
    // Colour codes would end up inside findings an agent reads back.
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...options?.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: grouped,
    })
    const kill = (): void => {
      if (grouped && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
          return
        } catch {
          // The group is already gone; fall through to the child itself.
        }
      }
      child.kill('SIGKILL')
    }
    if (grouped) process.once('exit', kill)
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (run: CapturedRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.off('exit', kill)
      resolvePromise(run)
    }
    // SIGKILL outright (a child ignoring SIGTERM would outlive the CLI's own
    // exit), and settle now rather than on `close`: a grandchild holding the
    // pipes would otherwise keep `close` from firing until it finishes.
    const timer =
      options?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            kill()
            child.stdout.destroy()
            child.stderr.destroy()
            settle({ exitCode: 1, stdout, stderr, timedOut: true })
          }, options.timeoutMs)
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.off('exit', kill)
      rejectPromise(error)
    })
    // What the child left behind would hold the pipes open, keeping `close` from firing.
    if (grouped) child.on('exit', kill)
    child.on('close', (code) => settle({ exitCode: code ?? 1, stdout, stderr }))
  })
