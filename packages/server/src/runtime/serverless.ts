/**
 * The one place server decides "which serverless runtime is this". Kept
 * import-free so the session middleware and the Lambda adapter can both read
 * it without either dragging the other in. Labels match the CLI's
 * DEPLOY_TARGET_PROFILES in packages/cli/src/deploy-runtime.ts, and
 * plugin-cloudflare's `isWorkersRuntime()` reads the same user agent.
 */

export type ServerlessRuntimeId = 'cloudflare' | 'lambda' | 'vercel'

/** Pinned by packages/cli/tests/deploy-runtime.test.ts against DEPLOY_TARGET_PROFILES. */
export const SERVERLESS_RUNTIME_LABELS: Readonly<Record<ServerlessRuntimeId, string>> = {
  cloudflare: 'Cloudflare Workers',
  lambda: 'AWS Lambda',
  vercel: 'Vercel',
}

export interface ServerlessRuntime {
  readonly id: ServerlessRuntimeId
  /** The deploy target's name as the CLI checks report it. */
  readonly label: string
  /** A local emulator (`sam local`, `vercel dev`): the platform's env without its isolation. */
  readonly local: boolean
}

export function detectServerlessRuntime(): ServerlessRuntime | undefined {
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    return { id: 'cloudflare', label: SERVERLESS_RUNTIME_LABELS.cloudflare, local: false }
  }
  if (typeof process === 'undefined') {
    return undefined
  }
  const env = process.env
  if (env.AWS_LAMBDA_FUNCTION_NAME) {
    return { id: 'lambda', label: SERVERLESS_RUNTIME_LABELS.lambda, local: Boolean(env.AWS_SAM_LOCAL) }
  }
  if (env.VERCEL) {
    return { id: 'vercel', label: SERVERLESS_RUNTIME_LABELS.vercel, local: env.VERCEL_ENV === 'development' }
  }
  return undefined
}
