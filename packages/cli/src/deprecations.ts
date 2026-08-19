/**
 * Framework-level deprecation warnings.
 *
 * Each deprecation targets a specific API, config, or pattern that will
 * be removed in a future version.
 */
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { discoverAppSourceFiles, discoverDbArtifactFiles, discoverModelFiles } from './discovery'
import { extractClassDeclaration, findStaticClassProperty } from './model-parser'
import { parseSourceFile } from './parse-cache'

export interface Deprecation {
  /** Unique identifier */
  id: string
  /** What is deprecated */
  what: string
  /** Version when it was deprecated */
  since: string
  /** Version when it will be removed */
  removedIn: string
  /** What to use instead */
  replacement: string
  /** Detect usage in the project. Returns affected file paths. */
  detect(cwd: string): Promise<string[]>
}

async function detectModelStatic(cwd: string, property: string): Promise<string[]> {
  const files = await discoverModelFiles(cwd)
  const affected = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf-8')
      // Same AST predicate `guren check`'s legacy rule uses, so the two
      // commands cannot drift on what counts as a declaration (and comments
      // or access modifiers neither fake nor hide one).
      const ast = parseSourceFile(source, filePath)
      for (const node of ast?.program.body ?? []) {
        const classDecl = extractClassDeclaration(node)
        if (classDecl && findStaticClassProperty(classDecl, property)) {
          return relative(cwd, filePath)
        }
      }
      return null
    }),
  )
  return affected.filter((file): file is string => file !== null)
}

/**
 * Registry of all known deprecations.
 */
/**
 * Call sites that ask a storage disk for per-object visibility. Text search
 * rather than AST: the call can sit anywhere (a controller, a job, a
 * service), and the disk it targets is only known at runtime, so this
 * reports candidates for a human to read rather than pretending to resolve
 * which driver each one hits.
 */
async function detectLocalVisibilityCalls(cwd: string): Promise<string[]> {
  const files = await discoverAppSourceFiles(cwd)
  const affected = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf-8')
      const callsSetVisibility = source.includes('.setVisibility(')
      const putsWithVisibility = /\.put\([^)]*\bvisibility\s*:/s.test(source)
      return callsSetVisibility || putsWithVisibility ? relative(cwd, filePath) : null
    }),
  )
  return affected.filter((file): file is string => file !== null)
}

/**
 * Files that import the class-based seeder API rather than `defineSeeder`.
 *
 * Text search over the import statement, not the AST: what identifies the
 * deprecation is the specifier list on an import from `@guren/core`, and a
 * subclass of it can sit in any file the app puts code in. `@guren/server` is
 * matched too — the core-first rule says not to import from it, but an app
 * that already does is exactly the one this needs to reach.
 *
 * `defineSeeder` ends in the same six letters as `Seeder`, so the specifier is
 * matched on its own word boundaries; a file that imports only `defineSeeder`
 * is the supported case and must not be reported.
 */
const SEEDER_CLASS_SPECIFIERS = /\b(?:BaseSeeder|SeederRunner|createSeederRunner|resetCalledSeeders|Seeder|SeederClass|SeederInterface|SeederRunnerOptions)\b/
const GUREN_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@guren\/(?:core|server)['"]/g

async function detectSeederClassImports(cwd: string): Promise<string[]> {
  const files = [
    ...(await discoverAppSourceFiles(cwd)),
    ...(await discoverDbArtifactFiles(cwd, 'Seeder')),
  ]
  const affected = await Promise.all(
    files.map(async (filePath) => {
      const source = await readFile(filePath, 'utf-8')
      for (const match of source.matchAll(GUREN_IMPORT)) {
        const specifiers = match[1]
          .split(',')
          .map((part) => part.split(/\bas\b/)[0].replace(/^\s*type\s+/, '').trim())
          .filter(Boolean)
        if (specifiers.some((name) => SEEDER_CLASS_SPECIFIERS.test(name))) {
          return relative(cwd, filePath)
        }
      }
      return null
    }),
  )
  return affected.filter((file): file is string => file !== null)
}

export const deprecations: Deprecation[] = [
  {
    id: 'model-guarded',
    what: "Model 'static guarded' blacklist",
    since: '1.6.0',
    removedIn: '2.0.0',
    replacement:
      "Delete the declaration. The primary key is always stripped from mass assignment and credential columns "
      + "are denied by AuthenticatableModel; use 'static fillable = [...]' to allowlist the rest.",
    detect: (cwd) => detectModelStatic(cwd, 'guarded'),
  },
  {
    id: 'model-strict-fillable',
    what: "Model 'static strictFillable' flag",
    since: '1.6.0',
    removedIn: '2.0.0',
    replacement:
      'Delete the declaration — fillable is always strict. Each new throw is a field the model was silently '
      + 'dropping: add it to fillable or remove it from the payload.',
    detect: (cwd) => detectModelStatic(cwd, 'strictFillable'),
  },
  {
    id: 'local-disk-per-object-visibility',
    what: 'Per-object visibility on a local storage disk (setVisibility, or put({ visibility })) ',
    since: '2.7.0',
    removedIn: '3.0.0',
    replacement:
      'A local disk has no per-object visibility: what makes a file reachable is the disk root and whatever '
      + 'serves it, so these calls have never done anything. Declare the disk\'s "visibility" option to match '
      + 'what it is, and keep restricted files on a disk that is not served.',
    detect: detectLocalVisibilityCalls,
  },
  {
    id: 'seeder-class-convention',
    what: 'Class-based seeder API (BaseSeeder/Seeder, SeederRunner, createSeederRunner)',
    since: '2.9.0',
    removedIn: '3.0.0',
    replacement:
      "Write seeders with defineSeeder from '@guren/core' — its handler receives the { db } context "
      + 'that BaseSeeder.run() is declared not to take, and `db:seed` runs every seeder in the folder, '
      + 'so the SeederRunner orchestration (which no Guren command reaches) is not needed.',
    detect: detectSeederClassImports,
  },
]

/**
 * Check the project for deprecated API usage.
 */
export async function checkDeprecations(
  cwd: string,
): Promise<DeprecationWarning[]> {
  const warnings: DeprecationWarning[] = []

  for (const dep of deprecations) {
    const files = await dep.detect(cwd)
    if (files.length > 0) {
      warnings.push({
        id: dep.id,
        what: dep.what,
        since: dep.since,
        removedIn: dep.removedIn,
        replacement: dep.replacement,
        affectedFiles: files,
      })
    }
  }

  return warnings
}

export interface DeprecationWarning {
  id: string
  what: string
  since: string
  removedIn: string
  replacement: string
  affectedFiles: string[]
}
