import { isAbsolute, relative, sep } from 'node:path'

/**
 * A path as the user would type it: cwd-relative when it is under cwd, verbatim
 * otherwise. `relative()` resolves a relative input against cwd itself, so a
 * config's './db/schema.ts' and an absolute folder both land here.
 */
export function describePath(path: string): string {
  const relativePath = relative(process.cwd(), path)
  const outsideCwd = relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)
  return relativePath === '' || outsideCwd ? path : relativePath
}

export function describeMigrationsFolder(folder: string | undefined): string {
  return folder ? describePath(folder) : 'the migrations folder'
}

export function describeSeedersFolder(folder: string | undefined): string {
  return folder ? describePath(folder) : 'the seeders folder'
}
