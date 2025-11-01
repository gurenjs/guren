import { readdir, stat } from 'node:fs/promises'

export async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

export async function isDirectoryEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path)
    return entries.length === 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true
    }

    throw error
  }
}

export function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/gu, '-')
    .toLowerCase()
    .replace(/^-+|-+$/gu, '')
}

export function toTitleCase(value: string): string {
  const words = value
    .replace(/[-_]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)

  if (words.length === 0) {
    return 'Guren App'
  }

  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

export function toPackageName(value: string): string {
  const trimmed = value.trim()

  if (trimmed.startsWith('@')) {
    const withoutScope = trimmed.slice(1)
    const [scope, name = 'guren-app'] = withoutScope.split('/', 2)
    const safeScope = toKebabCase(scope)
    const safeName = toKebabCase(name)
    return `@${safeScope || 'guren'}/${safeName || 'app'}`
  }

  const safe = toKebabCase(trimmed)
  return safe || 'guren-app'
}
