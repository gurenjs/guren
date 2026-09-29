import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { composePage } from './page-bundle'

export const DEV_CENTER_ASSET_DIR = 'assets/dev-center'
export function composeDevCenterPage(pageDir: string): string {
  return composePage(pageDir, { template: 'index.html', entry: 'main.ts', placeholder: '__GUREN_DEV_CENTER_SCRIPT__', what: 'Dev Center' })
}
let shell: string | undefined
export function devCenterShell(): string {
  if (shell !== undefined) return shell
  try {
    shell = composeDevCenterPage(fileURLToPath(new URL('./dev-center-page/', import.meta.url)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    shell = readFileSync(fileURLToPath(new URL(`../${DEV_CENTER_ASSET_DIR}/index.html`, import.meta.url)), 'utf8')
  }
  return shell
}
