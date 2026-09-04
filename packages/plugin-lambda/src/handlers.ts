/**
 * The single source of truth tying the generated bundle to the
 * infrastructure: `lambda:build` emits a `handler` module re-exporting these
 * names, and the CDK construct maps them to Lambda handler identifiers.
 */
export const LAMBDA_HANDLER_MODULE = 'handler'

export const LAMBDA_HANDLER_EXPORTS = ['http', 'queue', 'schedule', 'console'] as const

export type LambdaHandlerExport = (typeof LAMBDA_HANDLER_EXPORTS)[number]

/** Lambda handler identifier for an export. */
export function lambdaHandlerId(name: LambdaHandlerExport): string {
  return `${LAMBDA_HANDLER_MODULE}.${name}`
}
