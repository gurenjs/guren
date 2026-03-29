import { autoConfigureInertiaAssets } from '@guren/core/runtime'
import app from './app.js'

autoConfigureInertiaAssets(app, {
  importMeta: import.meta,
  enableSsr: false,
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
