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

/**
 * Kept for compatibility with everything that already imports these from the
 * root. **Application code should import them from
 * `@guren/plugin-cloudflare/env` instead**: this entry also exports
 * `buildCloudflareOutput`, which drags the deploy generator and its node
 * builtins in behind it. See the header of `./env`.
 */
export { captureWorkersEnv, getWorkersEnv, resetWorkersEnv } from './env'
export { createWorkersHandler } from './handler'
export type { WorkersAppLike, WorkersExecutionContext, WorkersHandler } from './handler'
export { buildCloudflareOutput, flattenD1Migrations } from './build'
export type { BuildCloudflareOutputOptions } from './build'
export { R2Driver } from './storage/R2Driver'
export type { R2DriverOptions, R2PresignOptions, R2BucketLike } from './storage/R2Driver'
