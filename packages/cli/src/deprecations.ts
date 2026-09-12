/** Framework-level deprecation warnings. */
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  discoverAppConfigFiles,
  discoverAppSourceFiles,
  discoverDbArtifactFiles,
  discoverModelFiles,
  discoverTestFiles,
} from './discovery'
import { extractClassDeclaration, findStaticClassProperty } from './model-parser'
import { parseSourceFile } from './parse-cache'

export interface Deprecation {
  id: string
  what: string
  since: string
  removedIn: string
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
      // commands cannot drift on what counts as a declaration.
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
 * Call sites that ask a storage disk for per-object visibility. Text search
 * rather than AST: the disk a call targets is only known at runtime, so these
 * are candidates for a human to read, not resolved verdicts.
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

const GUREN_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@guren\/(?:core|server)['"]/g

/**
 * Files importing a specifier `matches` accepts from a Guren package.
 * `@guren/server` is matched alongside `@guren/core`: an app importing from it
 * despite the core-first rule is exactly the one this needs to reach.
 */
async function detectGurenImports(
  cwd: string,
  matches: (specifier: string) => boolean,
  files?: string[],
): Promise<string[]> {
  files ??= [
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
        if (specifiers.some(matches)) {
          return relative(cwd, filePath)
        }
      }
      return null
    }),
  )
  return affected.filter((file): file is string => file !== null)
}

/** `defineSeeder` ends in the same six letters as `Seeder`, so a specifier is matched on its own word boundaries. */
const SEEDER_CLASS_SPECIFIERS = /\b(?:BaseSeeder|SeederRunner|createSeederRunner|resetCalledSeeders|Seeder|SeederClass|SeederInterface|SeederRunnerOptions)\b/

/** Files that import the class-based seeder API rather than `defineSeeder`. */
const detectSeederClassImports = (cwd: string): Promise<string[]> =>
  detectGurenImports(cwd, (specifier) => SEEDER_CLASS_SPECIFIERS.test(specifier))

/** Files importing the `ScryptHasher` name for the class now exported as `Argon2Hasher`. */
const detectScryptHasherImports = (cwd: string): Promise<string[]> =>
  detectGurenImports(cwd, (specifier) => specifier === 'ScryptHasher')

const GLOBAL_SERVICE_SETTERS = new Set([
  'setGate',
  'setEncrypter',
  'setMailManager',
  'setQueueDriver',
  'setI18n',
  'setLogManager',
  'setNotificationManager',
  'setBroadcastManager',
  'setExceptionHandler',
  'setContainer',
  'setInertiaDocument',
  'setInertiaSsrRenderer',
  'setInertiaSharedProps',
])

const GLOBAL_SERVICE_GETTERS = new Set([
  'getGate',
  'getEncrypter',
  'getMailManager',
  'getQueueDriver',
  'getI18n',
  'tryGetI18n',
  'getLogManager',
  'getNotificationManager',
  'getBroadcastManager',
  'getExceptionHandler',
  'getContainer',
  'getInertiaSharedPropsResolver',
])

/**
 * Every source an app can call these from, which is wider than the `app/` scan
 * the other entries use: the setters live in `src/app.ts` and `config/*.ts`,
 * and the test-injection row of RFC 0023's Migration Path is reported rather
 * than rewritten, so a test file has to be reachable too.
 */
async function globalServiceFiles(cwd: string): Promise<string[]> {
  return [...(await discoverAppConfigFiles(cwd)), ...(await discoverTestFiles(cwd))]
}

const detectGlobalServiceImports = (names: Set<string>) => async (cwd: string): Promise<string[]> =>
  detectGurenImports(cwd, (specifier) => names.has(specifier), await globalServiceFiles(cwd))

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
  {
    id: 'scrypt-hasher-name',
    what: "The 'ScryptHasher' export name",
    since: '2.23.0',
    removedIn: '3.0.0',
    replacement:
      "Import 'Argon2Hasher' instead: it is the same class, under the name of what it writes "
      + "(Bun.password's Argon2id, never scrypt). For a hash every runtime can verify, use 'Hash', "
      + 'whose default is node:crypto scrypt.',
    detect: detectScryptHasherImports,
  },
  {
    id: 'global-service-setters',
    what:
      'Module-level service setters (setGate, setEncrypter, setMailManager, setQueueDriver, setI18n, '
      + 'setLogManager, setNotificationManager, setBroadcastManager, setExceptionHandler, setContainer, '
      + 'setInertiaDocument, setInertiaSsrRenderer, setInertiaSharedProps)',
    since: '2.23.0',
    removedIn: '3.0.0',
    replacement:
      "Bind the service on the owning app's container instead — container.instance(key, value) from a "
      + 'service provider. createApp({ inertia }) covers the document and SSR renderer, '
      + 'shareInertiaProps(fn, container) the shared props, and useAsDefaultApplication(app) the ambient '
      + 'application setContainer() chose. Run `bunx guren upgrade` for the rewrites that are mechanical.',
    detect: detectGlobalServiceImports(GLOBAL_SERVICE_SETTERS),
  },
  {
    id: 'global-service-getters',
    what:
      'Module-level service getters (getGate, getEncrypter, getMailManager, getQueueDriver, getI18n, '
      + 'tryGetI18n, getLogManager, getNotificationManager, getBroadcastManager, getExceptionHandler, '
      + 'getContainer, getInertiaSharedPropsResolver)',
    since: '2.23.0',
    removedIn: '3.0.0',
    replacement:
      'Resolve from the container that owns the call — this.make(key) in a controller, job or command, '
      + 'this.container.make(key) in a provider, getRequestContainer(ctx).make(key) in middleware, '
      + 'defaultContainer().make(key) elsewhere. The functional helpers (encrypt, decrypt, t, tc, can, '
      + 'cannot, defineGate, resolve, Job.dispatch) are unaffected.',
    detect: detectGlobalServiceImports(GLOBAL_SERVICE_GETTERS),
  },
]

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
