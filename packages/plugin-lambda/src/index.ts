import { definePlugin, type ServiceProviderConstructor } from '@guren/core'

/**
 * Configuration for the Lambda plugin. Currently empty — reserved so future
 * fields never force another registration-shape change.
 */
export interface LambdaPluginConfig {}

const factory = definePlugin<LambdaPluginConfig>({
  name: 'lambda',
  register() {},
})

/**
 * Register the Lambda plugin.
 *
 * @example createApp({ providers: [lambdaPlugin()] })
 */
export function lambdaPlugin(config: LambdaPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}

export { buildLambdaOutput } from './build'
export type { BuildLambdaOutputOptions } from './build'
export { LAMBDA_HANDLER_EXPORTS, LAMBDA_HANDLER_MODULE, lambdaHandlerId } from './handlers'
export type { LambdaHandlerExport } from './handlers'
