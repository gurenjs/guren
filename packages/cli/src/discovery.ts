import { readdir, access, readFile, stat } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])
const TEST_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/

/**
 * Recursively collect files from a directory matching given extensions.
 * Skips dotfiles and declaration files (.d.ts).
 */
export async function collectFiles(
  directory: string,
  extensions: Set<string> = SOURCE_EXTENSIONS,
): Promise<string[]> {
  const results: string[] = []

  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue

    const fullPath = join(directory, entry.name)

    if (entry.isDirectory()) {
      results.push(...(await collectFiles(fullPath, extensions)))
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.d.ts')) continue
      if (extensions.has(extname(entry.name))) {
        results.push(fullPath)
      }
    }
  }

  return results
}

export async function fileExists(cwd: string, relativePath: string): Promise<boolean> {
  try {
    await access(resolve(cwd, relativePath))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

export async function readIfExists(cwd: string, relativePath: string): Promise<string | null> {
  if (!(await fileExists(cwd, relativePath))) {
    return null
  }

  return readFile(resolve(cwd, relativePath), 'utf8')
}

export async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath)
    return s.isDirectory()
  } catch {
    return false
  }
}

function discoverDir(appRoot: string, subDir: string): Promise<string[]> {
  const dir = resolve(appRoot, subDir)
  return collectFiles(dir)
}

export function discoverModelFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Models')
}

export function discoverControllerFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Controllers')
}

export function discoverResourceFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Resources')
}

export function discoverEventFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Events')
}

export function discoverJobFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Jobs')
}

export function discoverMiddlewareFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/middleware')
}

export function discoverListenerFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Listeners')
}

export function discoverValidatorFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Http/Validators')
}

export function discoverPolicyFiles(appRoot: string): Promise<string[]> {
  return discoverDir(appRoot, 'app/Policies')
}

/**
 * Discover `*.test.{ts,tsx,mts,js,jsx,mjs}` files under the project's `tests/`
 * directory (the convention used by scaffolded apps and the blog example).
 */
export async function discoverTestFiles(appRoot: string): Promise<string[]> {
  const dir = resolve(appRoot, 'tests')
  const files = await collectFiles(dir, TEST_FILE_EXTENSIONS)
  return files.filter((file) => TEST_FILE_PATTERN.test(file))
}

/**
 * Extract a class name from a file path.
 * e.g., '/app/Models/Post.ts' → 'Post'
 */
export function classNameFromPath(filePath: string): string {
  const base = filePath.split('/').pop() ?? ''
  return base.replace(/\.(ts|mts|js|mjs)$/, '')
}

/**
 * Filter out index/barrel files from discovered file lists.
 */
export function excludeBarrelFiles(files: string[]): string[] {
  return files.filter((f) => {
    const base = f.split('/').pop() ?? ''
    return !base.startsWith('index.')
  })
}
