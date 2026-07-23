import { readdir, access, readFile, stat } from 'node:fs/promises'
import { resolve, join, extname, relative, sep } from 'node:path'

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs'])
const TEST_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])
const TEST_FILE_PATTERN = /\.test\.(ts|tsx|mts|js|jsx|mjs)$/

// Directories that never contain a project's own source/test files — skipped
// when scanning from the project root (not needed for the scoped app/**
// discoverers below, which never descend into these anyway).
export const NON_SOURCE_DIR_NAMES = new Set(['node_modules', 'dist', 'build', 'coverage'])

// Extensions worth parsing for import specifiers when scanning the whole
// project (arch boundary checks) rather than one known component directory.
export const IMPORTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs'])

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

/**
 * Path of `absPath` relative to `cwd`, with `/` separators regardless of
 * platform. Used wherever a path needs to be compared against a glob or a
 * git-diff entry, both of which are always POSIX-style.
 */
export function toPosixRelative(cwd: string, absPath: string): string {
  return relative(cwd, absPath).split(sep).join('/')
}

/**
 * Module name (e.g. `'billing'`) if `relPath` — a POSIX-relative path, as
 * produced by `toPosixRelative` — is under `modules/<name>/`, else `null`.
 * The single source of truth for "module path → name" shared by the arch
 * boundary checks and the consistency checks.
 */
export function moduleNameFromRelPath(relPath: string): string | null {
  const match = /^modules\/([^/]+)\//.exec(relPath)
  return match ? match[1] : null
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

/**
 * Directory names directly under `modules/` (RFC 0002) — e.g. `['billing',
 * 'inventory']`. Missing/absent `modules/` (the common case for apps that
 * haven't adopted modules) resolves to an empty list, not an error.
 */
export async function listModuleNames(appRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(resolve(appRoot, 'modules'), { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
}

/**
 * Absolute paths of directories directly under `modules/` — each is
 * expected to mirror the top-level app layout, so `modules/<name>/<subDir>`
 * is scanned alongside `<appRoot>/<subDir>` for every `discover*Files`
 * function below.
 */
async function listModuleDirs(appRoot: string): Promise<string[]> {
  const names = await listModuleNames(appRoot)
  return names.map((name) => resolve(appRoot, 'modules', name))
}

/**
 * Scans `<appRoot>/<subDir>` plus `<subDir>` under every module directory
 * discovered by `listModuleDirs` — the single fan-out point that makes
 * every `discover*Files` function below (and everything built on them:
 * `check`, `audit`, `context`, `model:list`, `doctor`) module-aware for free.
 */
async function discoverDir(appRoot: string, subDir: string): Promise<string[]> {
  const roots = [appRoot, ...(await listModuleDirs(appRoot))]
  const groups = await Promise.all(roots.map((root) => collectFiles(resolve(root, subDir))))
  return groups.flat()
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
