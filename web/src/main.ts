import { autoConfigureInertiaAssets, DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS } from '@guren/core/runtime'
import app from './app.js'

autoConfigureInertiaAssets(app, {
  importMeta: import.meta,
  rootPublicAssets: {
    // The framework's default root-asset extensions plus `.js`, so dev and
    // `bun run preview` serve the mermaid bundle the docs pages load. Workers
    // Static Assets already serve all of public/ from the root. Spread rather
    // than restated because the option replaces the default list.
    extensions: [...DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS, '.js'],
  },
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
