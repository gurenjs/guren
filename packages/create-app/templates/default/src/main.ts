import { autoConfigureInertiaAssets } from '@guren/server'
import app from './app.js'
import '../routes/web.js'
import '../app/Models/relations.js'

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
