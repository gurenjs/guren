import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { GRAPH_OUTPUT_LIMIT } from './application-graph-fresh'
import { cliEntry } from './cli-entry'

const execute = promisify(execFile)

export type ExposureResult = { schemaVersion: 1; [key: string]: unknown } | { schemaVersion: 1; error: { code: string; message: string } }

function isExposureResult(value: unknown): value is ExposureResult {
  if (typeof value !== 'object' || value === null) return false
  const document = value as { schemaVersion?: unknown; packages?: unknown; error?: { message?: unknown } }
  return document.schemaVersion === 1 && (Array.isArray(document.packages) || typeof document.error?.message === 'string')
}

/** `guren deps:exposure --json` in a child, under the graph tool's time and output bounds; exit 1 carries a partial document. */
export async function freshDependencyExposure(cwd: string, packageName?: string): Promise<ExposureResult> {
  const args = [cliEntry(), 'deps:exposure', '--json', '--app', cwd, ...(packageName === undefined ? [] : ['--package', packageName])]
  let stdout: string
  try {
    stdout = (await execute(process.execPath, args, { cwd, timeout: 60_000, maxBuffer: GRAPH_OUTPUT_LIMIT })).stdout
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean }
    if (failure.code !== 1 || failure.killed || typeof failure.stdout !== 'string') {
      return { schemaVersion: 1, error: { code: 'child-failed', message: 'Dependency exposure collection failed or exceeded its time/output limit; pass `package` to narrow it.' } }
    }
    stdout = failure.stdout
  }
  try {
    const parsed: unknown = JSON.parse(stdout)
    if (isExposureResult(parsed)) return parsed
  } catch {
    // Falls through to the invalid-output result.
  }
  return { schemaVersion: 1, error: { code: 'invalid-output', message: 'Dependency exposure collection did not return a valid document.' } }
}
