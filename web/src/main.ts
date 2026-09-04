import { autoConfigureInertiaAssets } from '@guren/core/runtime'
import app from './app.js'

autoConfigureInertiaAssets(app, {
  importMeta: import.meta,
  rootPublicAssets: {
    // The framework's default root-asset extensions plus `.js`, so dev and
    // `bun run preview` serve the mermaid bundle the docs pages load. Workers
    // Static Assets already serve all of public/ from the root. Restated
    // rather than extended because the option replaces the default list.
    extensions: [
      '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif',
      '.webmanifest', '.txt', '.js',
    ],
  },
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
