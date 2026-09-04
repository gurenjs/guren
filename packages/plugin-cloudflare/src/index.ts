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

/** Register the Cloudflare plugin: `createApp({ providers: [cloudflarePlugin()] })`. */
export function cloudflarePlugin(config: CloudflarePluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}

/**
 * Compatibility re-export. **Application code should import these from
 * `@guren/plugin-cloudflare/env`**: this entry also exports `buildCloudflareOutput`,
 * which drags the deploy generator and its node builtins in behind it.
 */
export { captureWorkersEnv, getWorkersEnv, resetWorkersEnv } from './env'
export { createWorkersHandler } from './handler'
export type { WorkersAppLike, WorkersExecutionContext, WorkersHandler } from './handler'
export { buildCloudflareOutput, flattenD1Migrations } from './build'
export type { BuildCloudflareOutputOptions } from './build'
export { R2Driver } from './storage/R2Driver'
export type { R2DriverOptions, R2PresignOptions, R2BucketLike } from './storage/R2Driver'
