import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export interface WriterOptions {
  force?: boolean
}

export async function writeFileSafe(relativePath: string, contents: string, options: WriterOptions = {}): Promise<string> {
  const fullPath = resolve(process.cwd(), relativePath)

  if (!options.force) {
    try {
      await access(fullPath)
      throw new Error(`${relativePath} already exists. Use --force to overwrite.`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
  }

  await mkdir(dirname(fullPath), { recursive: true })
  await writeFile(fullPath, contents, 'utf8')
  return fullPath
}

export function pascalCase(value: string): string {
  return value
    .replace(/(?:^|[-_\s]+)([a-zA-Z])/gu, (_, char: string) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/gu, '')
}

export function camelCase(value: string): string {
  const pascal = pascalCase(value)
  return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

export function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[_\s]+/gu, '-')
    .toLowerCase()
}

export function resourceName(value: string): { className: string; fileName: string } {
  const className = pascalCase(value)
  const fileName = kebabCase(value)
  return { className, fileName }
}
