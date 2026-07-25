// Assemble .cloudflare/ from an already-built app (`bun run build` runs
// first via the cloudflare:build script). Invoked through the plugin API
// with an explicit exit: validating the SSR bundle's render export imports
// the bundle, whose module side effects keep the event loop alive after the
// build itself has finished.
import { buildCloudflareOutput } from '@guren/plugin-cloudflare'

await buildCloudflareOutput({ rootDir: process.cwd(), skipAppBuild: true })
process.exit(0)
