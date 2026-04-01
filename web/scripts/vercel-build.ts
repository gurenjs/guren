/**
 * Assemble Vercel Build Output API structure.
 *
 * This keeps the web app aligned with the reusable plugin implementation.
 */
import { buildVercelOutput } from '@guren/plugin-vercel'

buildVercelOutput({
  rootDir: new URL('..', import.meta.url),
  entrypoint: new URL('../src/index.ts', import.meta.url),
})
