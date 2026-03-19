import { autoConfigureInertiaAssets } from '@guren/server'
import app from './app.js'
import '../routes/web.js'
import '../app/Models/relations.js'
import { initializeEventSystem } from '../app/Providers/EventServiceProvider.js'

autoConfigureInertiaAssets(app, {
  importMeta: import.meta,
})

export async function bootstrap() {
  // Initialize events, mail, and queue systems
  initializeEventSystem()

  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
