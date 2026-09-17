import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { DependencyManifest } from './drizzle-pins'

/**
 * A range from `@guren/cli`'s own manifest, read as `../package.json`: this package's
 * root from `src/` and `dist/` alike. The scaffolds that install a third-party package
 * take its range from here, so what the CLI was tested against and what an app gets agree.
 */
export function cliDependencyRange(
  field: 'dependencies' | 'devDependencies' | 'peerDependencies',
  name: string,
): string {
  const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DependencyManifest
  const range = manifest[field]?.[name]
  if (range === undefined) {
    throw new Error(`@guren/cli declares no ${name} in ${field}, so there is no range to install`)
  }
  return range
}
