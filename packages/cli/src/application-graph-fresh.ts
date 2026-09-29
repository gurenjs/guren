import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { cliEntry } from './cli-entry'
import { graphResultSchema, type GraphResult } from './application-graph'

const execute = promisify(execFile)
export const GRAPH_OUTPUT_LIMIT = 8 * 1024 * 1024

export async function freshApplicationGraph(cwd: string): Promise<GraphResult> {
  let stdout: string
  try {
    const result = await execute(process.execPath, [cliEntry(), 'graph', '--json', '--app', cwd], {
      cwd, timeout: 60_000, maxBuffer: GRAPH_OUTPUT_LIMIT,
    })
    stdout = result.stdout
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean }
    if (failure.code !== 1 || failure.killed || typeof failure.stdout !== 'string') {
      return { schemaVersion: 1, error: { code: 'child-failed', message: 'Graph collection failed or exceeded its time/output limit.' } }
    }
    stdout = failure.stdout
  }
  try { return graphResultSchema.parse(JSON.parse(stdout)) } catch {
    return { schemaVersion: 1, error: { code: 'invalid-output', message: 'Graph collection did not return a valid graph result.' } }
  }
}
