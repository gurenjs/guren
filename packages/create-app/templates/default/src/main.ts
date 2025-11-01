import { configureInertiaAssets } from '@guren/server'
import app from './app'
import '../routes/web'

configureInertiaAssets(app, {
  importMeta: import.meta,
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
