// Assemble .cloudflare/ from an already-built app (`bun run build` runs first
// via the cloudflare:build script). The explicit exit is required: validating
// the SSR bundle's render export imports it, and its module side effects keep
// the event loop alive after the build has finished.
import { buildCloudflareOutput } from '@guren/plugin-cloudflare'

await buildCloudflareOutput({ rootDir: process.cwd(), skipAppBuild: true })
process.exit(0)
