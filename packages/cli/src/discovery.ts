import { readdir, access, readFile, stat } from 'node:fs/promises'
import { resolve, join, extname } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])
const TEST_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/

// Directories that never contain a project's own source/test files — skipped
// when scanning from the project root (not needed for the scoped app/**
// discoverers below, which never descend into these anyway).
const NON_SOURCE_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage'])

/**
 * Recursively collect files from a directory matching given extensions.
 * Skips dotfiles, declaration files (.d.ts), and any directory named in
 * `excludeDirNames`.
 */
export async function collectFiles(
  directory: string,
  extensions: Set<string> = SOURCE_EXTENSIONS,
  excludeDirNames: Set<string> = new Set(),
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
      if (excludeDirNames.has(entry.name)) continue
      results.push(...(await collectFiles(fullPath, extensions, excludeDirNames)))
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
 * Discover `*.test.{ts,tsx,mts,js,jsx,mjs}` files anywhere in the project:
 * under `tests/` (the convention used by scaffolded apps and the blog
 * example) as well as colocated next to source files elsewhere (the
 * convention this framework's own packages use — see CLAUDE.md).
 */
export async function discoverTestFiles(appRoot: string): Promise<string[]> {
  const files = await collectFiles(appRoot, TEST_FILE_EXTENSIONS, NON_SOURCE_DIR_NAMES)
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
