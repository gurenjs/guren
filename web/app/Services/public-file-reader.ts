// `bun run preview` reads the files Workers Static Assets would serve straight
// from public/. Reached only by dynamic import, so node:fs stays off the
// Workers bundle's request path.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { AssetReader } from './DocsStore.js'

const defaultPublicDir = resolve(import.meta.dirname, '../../public')

export function createPublicFileReader(publicDir = defaultPublicDir): AssetReader {
  return async (path) => {
    try {
      return await readFile(resolve(publicDir, `.${path}`), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw error
    }
  }
}
