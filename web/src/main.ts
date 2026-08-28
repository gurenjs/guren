import { autoConfigureInertiaAssets } from '@guren/core/runtime'
import app from './app.js'

autoConfigureInertiaAssets(app, {
  importMeta: import.meta,
  rootPublicAssets: {
    // The framework's default root-asset extensions plus `.js`, so the local
    // server serves /docs-assets/mermaid.js — the diagram library the docs
    // pages load (pages/Docs/Show.tsx). Workers Static Assets serve every
    // file under public/ from the root already, so this only closes the gap
    // for `bun run preview` and dev. Restated rather than extended because
    // the option replaces the default list.
    extensions: [
      '.svg', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif',
      '.webmanifest', '.txt', '.js',
    ],
    // Without this the file is served as application/octet-stream and the
    // browser refuses to execute it. Workers Static Assets type `.js`
    // correctly on their own, so this too is local-only.
    contentTypeMap: { '.js': 'text/javascript; charset=utf-8' },
  },
})

export async function bootstrap() {
  await app.boot()
  return app
}

export const ready = bootstrap()

export default app
