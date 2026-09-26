import { AsyncLocalStorage } from 'node:async_hooks'

const commandStatus = new AsyncLocalStorage<{ failed: boolean }>()

/**
 * Records a diagnostic failure without interrupting report generation.
 * Direct callers outside runCli retain the helpers' process exit-code behavior.
 */
export function markCommandFailed(): void {
  const status = commandStatus.getStore()
  if (status) status.failed = true
  else process.exitCode = 1
}

/** Each invocation owns its result, including nested or concurrent invocations. */
export async function runWithCommandStatus(run: () => Promise<unknown>): Promise<number> {
  const status = { failed: false }
  return commandStatus.run(status, async () => {
    await run()
    return status.failed ? 1 : 0
  })
}
