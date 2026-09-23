import { autoConfigureInertiaAssets, DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS } from '@guren/core/runtime'
import app from './app.js'

autoConfigureInertiaAssets(app, {
  importMeta: import.meta,
  rootPublicAssets: {
    // The framework's default root-asset extensions plus `.js` and `.woff2`, so
    // dev and `bun run preview` serve the mermaid bundle the docs pages load and
    // the fonts app.css names. Workers Static Assets already serve all of public/
    // from the root. Spread rather than restated: the option replaces the list.
    extensions: [...DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS, '.js', '.woff2'],
    contentTypeMap: { '.woff2': 'font/woff2' },
  },
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
