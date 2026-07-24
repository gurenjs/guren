import { ServiceProvider } from '@guren/core'

export class GurenPluginCloudflareProvider extends ServiceProvider {
  register(): void {}
}

export { captureWorkersEnv, getWorkersEnv, resetWorkersEnv } from './env'
export { createWorkersHandler } from './handler'
export type { WorkersAppLike, WorkersExecutionContext, WorkersHandler } from './handler'
export { buildCloudflareOutput } from './build'
export type { BuildCloudflareOutputOptions } from './build'
