/**
 * The one place server decides "which serverless runtime is this". Kept
 * import-free so the session middleware and the Lambda adapter can both read
 * it without either dragging the other in. plugin-cloudflare's
 * `isWorkersRuntime()` reads the same user agent.
 */

export type ServerlessRuntimeId = 'cloudflare' | 'lambda' | 'vercel'

/** The deploy targets' names as the CLI checks report them; the CLI reads these. */
export const SERVERLESS_RUNTIME_LABELS: Readonly<Record<ServerlessRuntimeId, string>> = {
  cloudflare: 'Cloudflare Workers',
  lambda: 'AWS Lambda',
  vercel: 'Vercel',
}

export interface ServerlessRuntime {
  readonly id: ServerlessRuntimeId
  /** The platform's env seen through a local emulator; what that means is the caller's call. */
  readonly emulator?: 'sam-local' | 'vercel-dev'
}

export function detectServerlessRuntime(): ServerlessRuntime | undefined {
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    return { id: 'cloudflare' }
  }
  if (typeof process === 'undefined') {
    return undefined
  }
  const env = process.env
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    return env.AWS_SAM_LOCAL ? { id: 'lambda', emulator: 'sam-local' } : { id: 'lambda' }
  }
  if (env.VERCEL) {
    return env.VERCEL_ENV === 'development' ? { id: 'vercel', emulator: 'vercel-dev' } : { id: 'vercel' }
  }
  return undefined
}
