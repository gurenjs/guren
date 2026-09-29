/**
 * The half of the dev-only runtime error collector that every build carries:
 * the binding names, the capture call ExceptionHandler makes, and the loader for
 * `./runtime-errors`. The buffer (node:fs frame resolution, hono/route) stays
 * behind that loader so a deploy bundle drops it.
 */
import type { Context } from 'hono'

import { isMcpEndpointEnabled } from './endpoint'
import { tryGetRequestContainer } from '../http/request-container'

export const RUNTIME_ERRORS_BINDING = 'dev.runtimeErrors'
export const RUNTIME_ERRORS_PATH = '/_guren/runtime/errors'

/** What the `RUNTIME_ERRORS_BINDING` binding answers; `RuntimeErrorBuffer` implements it. */
export interface RuntimeErrorCollector {
  capture(error: Error, ctx: Context, status: number): void
}

type RuntimeErrorsModule = typeof import('./runtime-errors')

let loading: Promise<RuntimeErrorsModule> | undefined

/**
 * The buffer module while the collector is enabled, else undefined. The NODE_ENV
 * read is plain member access so a deploy build's `--define` settles the branch
 * and the bundler drops the `import()` with it; `isMcpEndpointEnabled()` alone is
 * a call no define can settle. `tests/mcp/runtime-errors.test.ts` pins the form.
 */
export function loadRuntimeErrorsModule(): Promise<RuntimeErrorsModule> | undefined {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production' && isMcpEndpointEnabled()) {
    return loading ??= import('./runtime-errors')
  }
  return undefined
}

/** Only ExceptionHandler calls this, after applying its dontReport policy. */
export function captureRuntimeError(error: Error, ctx: Context, status: number): void {
  if (!isMcpEndpointEnabled() || status < 500 || status > 599 || !Number.isInteger(status)) return
  try {
    tryGetRequestContainer(ctx)?.makeOptional<RuntimeErrorCollector>(RUNTIME_ERRORS_BINDING)?.capture(error, ctx, status)
  } catch {
    // Development instrumentation must never replace the application exception.
  }
}
