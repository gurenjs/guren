import { definePlugin, type ServiceProviderConstructor } from '@guren/core'

/**
 * Configuration for the Cloudflare plugin. Currently empty — reserved for
 * upcoming RFC 0003 parts (session/OAuth-state store wiring on Workers).
 */
export interface CloudflarePluginConfig {}

const factory = definePlugin<CloudflarePluginConfig>({
  name: 'cloudflare',
  register() {},
})

/**
 * Register the Cloudflare plugin.
 *
 * @example
 * ```typescript
 * createApp({ providers: [cloudflarePlugin()] })
 * ```
 */
export function cloudflarePlugin(config: CloudflarePluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}

export { captureWorkersEnv, getWorkersEnv, resetWorkersEnv } from './env'
export { createWorkersHandler } from './handler'
export type { WorkersAppLike, WorkersExecutionContext, WorkersHandler } from './handler'
export { buildCloudflareOutput } from './build'
export type { BuildCloudflareOutputOptions } from './build'
