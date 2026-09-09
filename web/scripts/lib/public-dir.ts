// web/public for the build scripts, and where a public URL path lands in it.
// The app's own reader (app/Services/public-file-reader.ts) resolves the same
// directory from its own location; this module must not ship in the Worker.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const publicDir = fileURLToPath(new URL('../../public', import.meta.url))

export function publicFile(publicPath: string): string {
  return resolve(publicDir, `.${publicPath}`)
}
