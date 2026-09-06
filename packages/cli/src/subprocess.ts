import { spawn } from 'node:child_process'

export interface CapturedRun {
  exitCode: number
  stdout: string
  stderr: string
}

/** A subprocess run to completion with its output captured. `command[0]` is the executable. */
export type CapturedExec = (command: string[], cwd: string) => Promise<CapturedRun>

/** The Bun that is running this process, or a `bun` on PATH under Node. */
export function bunExecutable(): string {
  return process.versions.bun ? process.execPath : 'bun'
}

export const runCaptured: CapturedExec = (command, cwd) =>
  new Promise((resolvePromise, rejectPromise) => {
    const [executable, ...args] = command
    if (!executable) {
      rejectPromise(new Error('empty command'))
      return
    }
    // Colour codes would end up inside findings an agent reads back.
    const child = spawn(executable, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }))
  })
