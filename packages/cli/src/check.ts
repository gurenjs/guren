import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import {
  discoverCommandFiles,
  discoverControllerFiles,
  discoverModelFiles,
  excludeBarrelFiles,
  fileExists,
  hasControllerTest,
  describeControllerTestMiss,
  classNameFromPath,
  toPosixRelative,
  listModuleNames,
  moduleNameFromRelPath,
  formatTruncatedList,
} from './discovery'
import { extractClassDeclaration } from './model-parser'
import { camelCase, escapeRegExp } from './utils'
import { ParseCache } from './parse-cache'
import { extractInertiaPageRefs, resolveInertiaPageFile, expectedInertiaPagePath } from './inertia-pages'
import { runArchCheck } from './arch-check'
import { runDocsCheck } from './docs-check'
import { runSpecCheck } from './spec-check'
import { getChangedFiles } from './changed-files'
import { check, type CheckResult, type CheckReport, type CheckStatus } from './check-result'

export type { CheckStatus, CheckResult, CheckReport }

export interface RunCheckOptions {
  cwd?: string
  json?: boolean
  routesFile?: string
  /**
   * Run architecture boundary checks only (`guren.arch.ts` + derived module
   * rules), skipping the route/controller/page/manifest checks below. Fast
   * path for the agent-harness edit hook.
   */
  arch?: boolean
  /**
   * Restrict file-scanning checks (empty methods, arch boundaries) to files
   * changed vs. the merge base with main, plus uncommitted/untracked files.
   * Falls back to checking everything when not in a git repo.
   */
  changed?: boolean
  /**
   * Run doc-link checks only (docs/ frontmatter + @docs tags), skipping
   * everything else. Like `--arch`, a brand-new fast path that gates on
   * exit code from day one.
   */
  docs?: boolean
  /** Warn when a doc's `last_reviewed` is older than this many days. Off when unset. */
  docsTtlDays?: number
  /** Run spec drift checks only (docs/spec/ vs regenerated views). */
  spec?: boolean
}

/**
 * Module name (e.g. `'billing'`) if `filePath` is under `modules/<name>/`,
 * else `null`. Lets checks that assume a single project-root file (tests,
 * schema) resolve the right module-scoped equivalent instead of always
 * looking at the top level.
 */
function moduleNameFor(cwd: string, filePath: string): string | null {
  return moduleNameFromRelPath(toPosixRelative(cwd, filePath))
}

/**
 * Verifies every `modules/<name>/db/schema.ts` is re-exported from the
 * project's root `db/schema.ts` — the wiring `make:module` performs
 * automatically (RFC 0002). A module without a `db/schema.ts` is skipped
 * (nothing to aggregate); a project without a root `db/schema.ts` warns
 * rather than failing, since not every app uses a database.
 */
async function checkModuleSchemaAggregation(cwd: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const moduleNames = await listModuleNames(cwd)

  for (const moduleName of moduleNames) {
    const moduleSchemaPath = `modules/${moduleName}/db/schema.ts`
    if (!(await fileExists(cwd, moduleSchemaPath))) continue

    const rootSchemaPath = 'db/schema.ts'
    if (!(await fileExists(cwd, rootSchemaPath))) {
      results.push(
        check(
          `module-schema-aggregation:${moduleName}`,
          `${moduleName} schema aggregation`,
          'warn',
          `${moduleSchemaPath} exists but there is no root ${rootSchemaPath} to re-export it from.`,
          `Create ${rootSchemaPath} and add: export * from '../modules/${moduleName}/db/schema'`,
        ),
      )
      continue
    }

    const rootSchemaContent = await readFile(resolve(cwd, rootSchemaPath), 'utf-8')
    // Substring match, tolerant of quote style and a trailing .js/.ts extension.
    const isReExported = rootSchemaContent.includes(`modules/${moduleName}/db/schema`)

    results.push(
      check(
        `module-schema-aggregation:${moduleName}`,
        `${moduleName} schema aggregation`,
        isReExported ? 'pass' : 'warn',
        isReExported
          ? `${rootSchemaPath} re-exports ${moduleSchemaPath}.`
          : `${rootSchemaPath} does not re-export ${moduleSchemaPath}.`,
        isReExported ? undefined : `Add to ${rootSchemaPath}: export * from '../modules/${moduleName}/db/schema'`,
      ),
    )
  }

  return results
}

const CONSOLE_ENTRY = 'src/console.ts'

/**
 * A parsed entrypoint split into the two halves a registration check needs:
 * the local names it imports from a given path, and its source *outside* the
 * import statements.
 *
 * The split matters because an import alone is not a use: a leftover
 * `import SendDigestCommand from ...` next to an emptied `registerMany([])`
 * is exactly the state these checks exist to catch.
 *
 * Re-exports (`export { X } from './x'`) count as body, not imports: for a
 * module's `index.ts` they put a name on the module's public surface, which
 * is the thing being asked about.
 */
interface EntrySource {
  /** Top-level statements minus `import` declarations. */
  body: string
  /** One entry per `import`: its specifier and the local names it binds. */
  imports: Array<{ specifier: string; names: string[] }>
}

async function readEntrySource(cache: ParseCache, absPath: string): Promise<EntrySource | null> {
  const parsed = await cache.get(absPath)
  if (!parsed) return null

  const body = parsed.ast.program.body
    .filter((node) => node.type !== 'ImportDeclaration')
    .map((node) => parsed.source.slice(node.start ?? 0, node.end ?? 0))
    .join('\n')

  const imports = parsed.ast.program.body
    .filter((node) => node.type === 'ImportDeclaration')
    .map((node) => ({
      specifier: node.source.value,
      names: node.specifiers.map((specifier) => specifier.local.name),
    }))

  return { body, imports }
}

/**
 * Local names `entry` imports from inside `modules/<moduleName>/`. The
 * trailing slash is load-bearing: a bare `modules/billing` substring also
 * matches `modules/billing-reports`, which would credit one module's
 * registration to another.
 */
function bindingsFromModule(entry: EntrySource, moduleName: string): string[] {
  return entry.imports
    .filter((imported) => imported.specifier.includes(`modules/${moduleName}/`))
    .flatMap((imported) => imported.names)
}

/** Whether `body` uses `name` as an identifier. */
function referencesName(body: string, name: string): boolean {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'u').test(body)
}

/**
 * Whether `body` registers `binding`'s commands — `billingModule.commands`,
 * or a member chain ending there for a namespace import.
 *
 * Resolving the binding from the import first is what keeps this honest with
 * more than one module in play: matching `.commands` anywhere would report a
 * module as registered because a *different* module's line is present.
 */
export function registersCommandsOf(body: string, bindings: string[]): boolean {
  return bindings.some((binding) =>
    new RegExp(`\\b${escapeRegExp(binding)}\\s*(?:\\.\\s*[\\w$]+\\s*)*\\.\\s*commands\\b`, 'u').test(body),
  )
}

/**
 * Verifies every class under `app/Console/Commands` is referenced by the
 * console entrypoint that would register it. Nothing scans that directory at
 * runtime — a `ConsoleKernel` only knows the commands it was handed, so a
 * generated-but-unregistered command is dead code that no other signal
 * reports. `make:command` performs this wiring, so a warning here means a
 * command was written or moved by hand.
 *
 * Registration takes two shapes, and each command is only checked against
 * its own:
 * - a project-level command must be named by `src/console.ts`
 *   (`kernel.registerMany([SendDigestCommand])`)
 * - a module's command must be named by `modules/<name>/index.ts`
 *   (`defineModule({ commands: [...] })`), the module's public surface
 *
 * Detection is a name reference outside the entry's imports (see
 * {@link EntrySource}), and nothing more: it says the entrypoint uses the
 * class, not that the kernel ends up with it. `warn`, never `fail`, since a
 * name reference is not proof of registration in the other direction either.
 *
 * Not filtered by `--changed`, unlike the file-scanning checks above: what
 * decides the outcome is the *entrypoint's* content, so the edit that breaks
 * registration is usually to a file that isn't the command's. Filtering by
 * changed command files would report nothing for exactly that edit. The cost
 * is a directory walk over `app/Console/Commands` plus one read per entry.
 */
async function checkConsoleCommandRegistration(cwd: string, cache: ParseCache): Promise<CheckResult[]> {
  const commandFiles = excludeBarrelFiles(await discoverCommandFiles(cwd))
  if (commandFiles.length === 0) return []

  const results: CheckResult[] = []
  // Read at most once, however many modules ask about it.
  let consoleEntry: EntrySource | null | undefined

  // Grouped by entrypoint so a missing one is reported once, not once per
  // command it would have registered.
  const byEntry = new Map<string, { moduleName: string | null; files: string[] }>()
  for (const filePath of commandFiles) {
    const moduleName = moduleNameFor(cwd, filePath)
    const entry = moduleName ? `modules/${moduleName}/index.ts` : CONSOLE_ENTRY
    const group = byEntry.get(entry) ?? { moduleName, files: [] }
    group.files.push(filePath)
    byEntry.set(entry, group)
  }

  for (const [entry, { moduleName, files }] of byEntry) {
    const names = files.map((file) => classNameFromPath(file))
    const entryKey = `console-entry:${entry}`
    const entryTitle = moduleName ? `${moduleName} console registration` : 'Console entrypoint'

    // Probed separately because `readEntrySource` returns null for a missing
    // file and an unparseable one alike, and those want different advice.
    if (!(await fileExists(cwd, entry))) {
      results.push(
        check(
          entryKey,
          entryTitle,
          'warn',
          `${names.join(', ')} ${names.length === 1 ? 'exists' : 'exist'} but there is no ${entry} to register `
          + `${names.length === 1 ? 'it' : 'them'} in.`,
          moduleName
            // Both hops, since neither alone leaves the commands runnable.
            ? `Create ${entry} with defineModule({ commands: [${names.join(', ')}] }), then add to `
              + `${CONSOLE_ENTRY}: kernel.registerMany(${camelCase(moduleName)}Module.commands)`
            : `Create ${entry} exporting a ConsoleKernel, then add: kernel.registerMany([${names.join(', ')}])`,
        ),
      )
      continue
    }

    const entrySource = await readEntrySource(cache, resolve(cwd, entry))

    if (entrySource === null) {
      results.push(
        check(
          entryKey,
          entryTitle,
          'warn',
          `${entry} could not be parsed, so ${names.join(', ')} cannot be verified as registered.`,
          `Check ${entry} for a syntax error.`,
        ),
      )
      continue
    }

    for (const filePath of files) {
      const name = classNameFromPath(filePath)
      const registered = referencesName(entrySource.body, name)
      const suggestion = moduleName
        ? `Import ${name} in ${entry} and add it to defineModule({ commands: [...] }).`
        : `Import ${name} in ${entry} and add it to kernel.registerMany([...]).`

      results.push(
        check(
          // Module-qualified: a root and a module command may share a name.
          `console-command:${moduleName ? `${moduleName}/` : ''}${name}`,
          `${name} registration`,
          registered ? 'pass' : 'warn',
          registered
            ? `${entry} references ${name} outside its imports.`
            : `${entry} never uses ${name} outside its imports, so no kernel receives it.`,
          registered ? undefined : suggestion,
          toPosixRelative(cwd, filePath),
        ),
      )
    }

    if (moduleName) {
      consoleEntry ??= await readEntrySource(cache, resolve(cwd, CONSOLE_ENTRY))
      results.push(checkModuleCommandHop(consoleEntry, moduleName, names))
    }
  }

  return results
}

/**
 * Whether the project's console entrypoint registers `moduleName`'s commands
 * — the one hop `make:command` cannot patch, since
 * `kernel.registerMany(<module>.commands)` is a statement rather than an entry
 * in an existing array.
 *
 * Two shapes count, because both leave the commands runnable: the module's
 * `commands` array registered wholesale, or the individual classes registered
 * by name (what a project predating the `commands` field does).
 */
function checkModuleCommandHop(
  entry: EntrySource | null,
  moduleName: string,
  commandNames: string[],
): CheckResult {
  const binding = `${camelCase(moduleName)}Module`

  // Bindings come from the module's own import, so that `.commands` belonging
  // to a *different* module cannot satisfy this one. Only when that lookup
  // finds nothing — an import through a path alias, say — does the
  // conventional name stand in; adding it unconditionally could only
  // manufacture a pass.
  const imported = entry === null ? [] : bindingsFromModule(entry, moduleName)
  const bindings = imported.length > 0 ? imported : [binding]
  const hopped
    = entry !== null
    && (registersCommandsOf(entry.body, bindings)
      || commandNames.every((name) => referencesName(entry.body, name)))

  return check(
    `console-module-commands:${moduleName}`,
    `${moduleName} console commands`,
    hopped ? 'pass' : 'warn',
    hopped
      ? `${CONSOLE_ENTRY} registers ${moduleName}'s commands.`
      : `${CONSOLE_ENTRY} does not register ${moduleName}'s commands, so they never reach a kernel.`,
    hopped ? undefined : `Add to ${CONSOLE_ENTRY}: kernel.registerMany(${binding}.commands)`,
  )
}

export async function runCheck(options: RunCheckOptions = {}): Promise<CheckReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: CheckResult[] = []
  const cache = new ParseCache()

  const changedFiles = options.changed ? await getChangedFiles(cwd) : null
  const filterChanged = (files: string[]): string[] =>
    changedFiles ? files.filter((f) => changedFiles.has(toPosixRelative(cwd, f))) : files

  // `--arch` / `--docs` / `--spec` select suites; combining them runs the
  // union (never silently nothing). No flag = every suite.
  const selected = new Set<'arch' | 'docs' | 'spec'>([
    ...(options.arch ? (['arch'] as const) : []),
    ...(options.docs ? (['docs'] as const) : []),
    ...(options.spec ? (['spec'] as const) : []),
  ])
  const runs = (suite: 'core' | 'arch' | 'docs' | 'spec'): boolean =>
    selected.size === 0 || (suite !== 'core' && selected.has(suite))

  if (runs('core')) {
    // 1. Check controllers for empty methods
    const controllerFiles = filterChanged(await discoverControllerFiles(cwd))
    for (const filePath of controllerFiles) {
      const relPath = relative(cwd, filePath)
      const results = await checkEmptyMethods(cache, filePath, relPath)
      checks.push(...results)
    }

    // 2. Check controllers reference existing pages
    for (const filePath of controllerFiles) {
      const relPath = relative(cwd, filePath)
      const results = await checkInertiaPages(cache, filePath, cwd, relPath)
      checks.push(...results)
    }

    // 3. Check models have migrations
    const modelFiles = filterChanged(await discoverModelFiles(cwd))
    for (const filePath of modelFiles) {
      const relPath = relative(cwd, filePath)
      const name = classNameFromPath(filePath)
      const moduleName = moduleNameFor(cwd, filePath)
      const schemaPath = moduleName ? `modules/${moduleName}/db/schema.ts` : 'db/schema.ts'
      const hasSchema = await fileExists(cwd, schemaPath)
      if (hasSchema) {
        const schemaContent = await readFile(resolve(cwd, schemaPath), 'utf-8')
        const tableLower = name.toLowerCase() + 's'
        const hasTable = schemaContent.includes(`'${tableLower}'`) || schemaContent.includes(`"${tableLower}"`)
        checks.push(
          check(
            `model-schema:${name}`,
            `${name} schema`,
            hasTable ? 'pass' : 'warn',
            hasTable ? `Table definition found for ${name}.` : `No table '${tableLower}' found in ${schemaPath}.`,
            hasTable ? undefined : `Add table definition to ${schemaPath} for ${name}.`,
            relPath,
          ),
        )
      }
    }

    // 4. Check missing test files for controllers
    for (const filePath of controllerFiles) {
      const name = classNameFromPath(filePath)
      const moduleName = moduleNameFor(cwd, filePath)
      const hasTest = await hasControllerTest(cwd, filePath)
      const moduleFlag = moduleName ? ` --module ${moduleName}` : ''
      const message = hasTest
        ? `Test file found for ${name}.`
        : describeControllerTestMiss(cwd, filePath)
      const suggestion = hasTest
        ? undefined
        : `If these routes are not already covered, run: bunx guren make:test ${name.replace('Controller', '')} --controller${moduleFlag}`
      checks.push(check(`test:${name}`, `${name} tests`, hasTest ? 'pass' : 'warn', message, suggestion))
    }

    // 5. Check generated manifests are present
    const manifests = ['.guren/routes.gen.ts', '.guren/pages.gen.ts', '.guren/data.gen.ts']
    for (const manifest of manifests) {
      const exists = await fileExists(cwd, manifest)
      checks.push(
        check(
          `manifest:${manifest}`,
          manifest,
          exists ? 'pass' : 'warn',
          exists ? `${manifest} is present.` : `${manifest} is missing.`,
          exists ? undefined : 'Run: bunx guren codegen',
        ),
      )
    }

    // 6. Check every module's db/schema.ts is re-exported from the root
    // db/schema.ts (the wiring make:module performs automatically — this
    // catches modules created or edited by hand). Not an architecture
    // boundary rule, so it stays out of `--arch`'s fast path alongside
    // checks 1-5.
    const schemaAggregationResults = await checkModuleSchemaAggregation(cwd)
    checks.push(...schemaAggregationResults)

    // 7. Check every console command is registered with a kernel (the wiring
    // make:command performs automatically — this catches commands written or
    // moved by hand). Content-activated: apps with no app/Console/Commands
    // contribute nothing here.
    const commandRegistrationResults = await checkConsoleCommandRegistration(cwd, cache)
    checks.push(...commandRegistrationResults)
  }

  // 8. Doc-link checks (docs/ frontmatter + @docs tags, RFC 0004). Runs in
  // plain mode and under --docs; content-activated, so apps without the
  // docs convention contribute zero results here.
  if (runs('docs')) {
    const docsResults = await runDocsCheck({ cwd, changedFiles, ttlDays: options.docsTtlDays, cache })
    checks.push(...docsResults)
  }

  // 9. Spec drift checks (docs/spec/ vs regenerated views, RFC 0004).
  // Content-activated like docs; under --changed it only regenerates when
  // a spec-relevant file changed.
  if (runs('spec')) {
    const specResults = await runSpecCheck({ cwd, routesFile: options.routesFile, changedFiles })
    checks.push(...specResults)
  }

  // 10. Check architecture boundaries (guren.arch.ts + derived module rules)
  if (runs('arch')) {
    const archResults = await runArchCheck({ cwd, cache, changedFiles })
    checks.push(...archResults)
  }

  // Every checker above treats a file it couldn't parse as contributing
  // nothing, which is indistinguishable from a file with nothing wrong. Report
  // the skipped ones once, after all suites have finished asking the cache, so
  // a clean run over an incomplete scan says so instead of implying coverage.
  const skipped = cache.skippedFiles()
  if (skipped.length > 0) {
    const shown = formatTruncatedList(
      skipped.map(({ filePath, reason }) => `${toPosixRelative(cwd, filePath)} (${reason})`),
    )
    checks.push(
      check(
        'scan-coverage',
        'Scan coverage',
        'warn',
        `${skipped.length} file(s) were skipped and not checked: ${shown}.`,
        'Fix the syntax error (or file permissions) so these files are covered — until then results here are incomplete.',
      ),
    )
  }

  const report: CheckReport = {
    cwd,
    checks,
    passCount: checks.filter((c) => c.status === 'pass').length,
    warnCount: checks.filter((c) => c.status === 'warn').length,
    failCount: checks.filter((c) => c.status === 'fail').length,
  }

  return report
}

async function checkEmptyMethods(cache: ParseCache, filePath: string, relPath: string): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const parsed = await cache.get(filePath)
  if (!parsed) return results
  const { ast } = parsed

  for (const node of ast.program.body) {
    const classDecl = extractClassDeclaration(node)
    if (!classDecl) continue
    const className = classDecl.id?.name ?? classNameFromPath(filePath)

    for (const member of classDecl.body.body) {
      if (member.type === 'ClassMethod' && member.key.type === 'Identifier') {
        if (member.key.name === 'constructor') continue
        const body = member.body
        const isEmpty = body.body.length === 0
        if (isEmpty) {
          results.push(
            check(
              `empty-method:${className}.${member.key.name}`,
              `${className}.${member.key.name}()`,
              'warn',
              `Method ${member.key.name}() has an empty body.`,
              `Implement ${className}.${member.key.name}() in ${relPath}.`,
              relPath,
            ),
          )
        }
      }
    }
  }

  return results
}

async function checkInertiaPages(
  cache: ParseCache,
  filePath: string,
  cwd: string,
  relPath: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  // A syntax error doesn't invalidate this regex-only scan, so it asks the
  // cache for source rather than an AST — the file is read once either way.
  const source = await cache.source(filePath)
  if (source === null) return results

  for (const ref of extractInertiaPageRefs(source)) {
    if (ref.form === 'manifest') continue // pages.xxx pattern — already type-checked

    const pageFile = await resolveInertiaPageFile(cwd, ref.id)
    if (!pageFile) {
      results.push(
        check(
          `page:${ref.id}`,
          `Page ${ref.id}`,
          'fail',
          `Controller references page '${ref.id}' but no file found.`,
          `Create: ${expectedInertiaPagePath(ref.id)}`,
          relPath,
        ),
      )
    }
  }

  return results
}

export function renderCheckReport(report: CheckReport): void {
  consola.box(`Guren integrity check for ${report.cwd}`)

  for (const c of report.checks) {
    const prefix = c.status === 'pass' ? '[ok]' : c.status === 'warn' ? '[warn]' : '[fail]'
    const log = c.status === 'pass' ? consola.success : c.status === 'warn' ? consola.warn : consola.error
    log(`${prefix} ${c.title}: ${c.message}`)
    if (c.suggestion) {
      consola.info(`       → ${c.suggestion}`)
    }
  }

  console.log('')
  console.log(`Results: ${report.passCount} passed, ${report.warnCount} warnings, ${report.failCount} failures`)
}
