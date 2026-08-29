import { resolve, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { consola } from 'consola'
import type { Statement } from '@babel/types'
import {
  discoverControllerFiles,
  discoverModelFiles,
  fileExists,
  hasControllerTest,
  describeControllerTestMiss,
  classNameFromPath,
  toPosixRelative,
  listModuleNames,
  moduleFlagFor,
  moduleNameFor,
  formatTruncatedList,
} from './discovery'
import {
  classUsesAuthenticatableBase,
  extractClassDeclaration,
  extractTableIdentifier,
  findStaticClassProperty,
  firstClassDeclaration,
  resolveModelStringArrayConfig,
  staticStringProperty,
} from './model-parser'
import { checkConsoleCommandRegistration } from './console-check'
import { checkRoutePathParams, discoverRoutePathFiles } from './route-path-check'
import { affectsRouteWiring, checkRouteRegistrarWiring } from './routes-check'
import { checkRouteContracts } from './route-contract-check'
import { checkAgentRoutes } from './agent-route-check'

/**
 * Any file that could hold a route's params schema — which is any importable
 * source file, since a schema is usually imported into `routes/` from
 * somewhere else. Stated as the honest input set rather than an allow-list of
 * conventional directories, the way the modules spec view declares its own.
 */
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|js|jsx|mjs)$/
import { checkSchemaTimestamps } from './schema-check'
import {
  checkAttachableModels,
  checkAttachmentsConfig,
  checkAttachmentsDelivery,
  discoverAttachmentsConfigFiles,
} from './attachments-check'
import { parseSchemaTables, schemaPathFor, type SchemaTable } from './schema-parser'
import { ParseCache } from './parse-cache'
import { extractInertiaPageRefs, resolveInertiaPageFile, expectedInertiaPagePath } from './inertia-pages'
import { describePageManifestSuppression, PAGES_MANIFEST_FILE, planPageManifest } from './pages-types'
import { runArchCheck } from './arch-check'
import { runDocsCheck } from './docs-check'
import { runI18nCheck } from './i18n-check'
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
   *
   * Two checks answer a whole-directory question rather than a per-file one
   * — translation parity and route registrar wiring — so `--changed` gates
   * each as a unit on its own directory instead of filtering its inputs.
   */
  changed?: boolean
  /**
   * Run doc-link checks only (docs/ frontmatter + @docs tags), skipping
   * everything else. Like `--arch`, a brand-new fast path that gates on
   * exit code from day one.
   */
  docs?: boolean
  /** Run spec drift checks only (docs/spec/ vs regenerated views). */
  spec?: boolean
  /**
   * Run translation catalog checks only (lang/<locale>/*.json key and
   * placeholder parity). Content-activated: apps without lang/ contribute
   * zero results.
   */
  i18n?: boolean
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

export async function runCheck(options: RunCheckOptions = {}): Promise<CheckReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: CheckResult[] = []
  const cache = new ParseCache()

  const changedFiles = options.changed ? await getChangedFiles(cwd) : null
  const filterChanged = (files: string[]): string[] =>
    changedFiles ? files.filter((f) => changedFiles.has(toPosixRelative(cwd, f))) : files

  // `--arch` / `--docs` / `--spec` select suites; combining them runs the
  // union (never silently nothing). No flag = every suite.
  const selected = new Set<'arch' | 'docs' | 'spec' | 'i18n'>([
    ...(options.arch ? (['arch'] as const) : []),
    ...(options.docs ? (['docs'] as const) : []),
    ...(options.spec ? (['spec'] as const) : []),
    ...(options.i18n ? (['i18n'] as const) : []),
  ])
  const runs = (suite: 'core' | 'arch' | 'docs' | 'spec' | 'i18n'): boolean =>
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

    // The schema every check below reads, parsed once per run rather than per
    // model (checks 3 and 8 both consume it).
    const schemaTables = await parseSchemaTables(cwd)

    // 3. Check each model binds a table its schema declares. The unfiltered
    // list is kept for check 8.6, which (like 8/8.5) is deliberately not
    // changed-filtered.
    const allModelFiles = await discoverModelFiles(cwd)
    const modelFiles = filterChanged(allModelFiles)
    for (const filePath of modelFiles) {
      const relPath = relative(cwd, filePath)
      const name = classNameFromPath(filePath)
      checks.push(...(await checkMassAssignmentConfig(cache, filePath, name, relPath)))
      checks.push(...(await checkModelTableBinding(cache, cwd, filePath, name, relPath, schemaTables)))
    }

    // 4. Check missing test files for controllers
    for (const filePath of controllerFiles) {
      const name = classNameFromPath(filePath)
      const hasTest = await hasControllerTest(cwd, filePath)
      const moduleFlag = moduleFlagFor(cwd, filePath)
      const message = hasTest
        ? `Test file found for ${name}.`
        : describeControllerTestMiss(cwd, filePath)
      const suggestion = hasTest
        ? undefined
        : `If these routes are not already covered, run: bunx guren make:test ${name.replace('Controller', '')} --controller${moduleFlag}`
      // Advisory: a missing test is advice, not an integrity failure, so
      // exit-code gates (check --ci) must not fail on it.
      checks.push({ ...check(`test:${name}`, `${name} tests`, hasTest ? 'pass' : 'warn', message, suggestion), advisory: true })
    }

    // 5. Check generated manifests are present. Whether the pages manifest is
    // one of them is codegen's call, not this file's — an app with no page
    // components has none, and neither does an API-only app that somehow
    // acquired some (see planPageManifest).
    const pagesPlan = await planPageManifest(cwd)
    // The suppressed manifest, reported rather than assumed. The manifest list
    // below drops the file on this branch, so without this nothing would say a
    // word about one left on disk importing a package the app does not have —
    // which is the state that actually fails the typecheck.
    const suppressed = describePageManifestSuppression(pagesPlan)
    if (suppressed) {
      checks.push({
        ...check('pages-manifest', 'Pages manifest', 'warn', suppressed.message, suppressed.fix),
        advisory: suppressed.advisory,
      })
    }
    const manifests = [
      '.guren/routes.gen.ts',
      ...(pagesPlan.reason === 'pages' ? [PAGES_MANIFEST_FILE] : []),
      '.guren/data.gen.ts',
    ]
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

    // 7.5. Check every routes file's registrar is reached from the entry
    // registrar that would mount it — the app's for `routes/`, the registrar
    // `defineModule({ routes })` names for `modules/<name>/routes/`. This
    // catches routes files written, moved, or unhooked by hand, whose only
    // other symptom is a 404. Not an architecture boundary rule, so it stays
    // out of `--arch`'s fast path alongside checks 6-8.
    //
    // Gated as a unit under --changed, the way check 10.5 gates i18n — see
    // checkRouteRegistrarWiring for why filtering by changed *candidate*
    // would miss the edit that usually breaks the wiring.
    const routesChanged =
      !changedFiles || [...changedFiles].some((file) => affectsRouteWiring(file, options.routesFile))
    if (routesChanged) {
      const routeWiringResults = await checkRouteRegistrarWiring({ cwd, cache, routesFile: options.routesFile })
      checks.push(...routeWiringResults)

      // 7.6. Check route paths for `:name*`, which reads as a wildcard and
      // is not one — Hono registers a single-segment parameter named
      // literally `name*`. Unlike 7.5 this is genuinely a per-file question
      // (a `:slug*` can only arrive by editing the file that holds it), so it
      // is changed-*filtered* like checks 1-4. It shares 7.5's gate all the
      // same: `affectsRouteWiring` covers every file this reads, and asking a
      // string predicate first is what keeps a controller-only save from
      // paying for a scan of routes/ and every module.
      const routePathFiles = filterChanged(await discoverRoutePathFiles(cwd, options.routesFile))
      checks.push(...(await checkRoutePathParams({ cwd, cache, files: routePathFiles })))
    }

    // 7.7. Check each route's `params` schema keys and `bind` keys against the
    // parameters its path declares. Runs on loaded definitions, not the AST:
    // the registered path is the joined one (group prefixes, resource
    // expansions), and a params schema is usually imported from elsewhere, so
    // its keys are not in the routes file to read.
    //
    // Deliberately outside 7.5's `routesChanged` gate: a params schema can be
    // declared in any source file, so every file pattern narrower than "all
    // sources" would be a guess that reads as coverage. Under --changed it
    // gates on exactly that — the same honest input set the modules spec view
    // declares — which still skips a docs- or lang-only run, the case where
    // this would otherwise import the whole app for nothing. The edit-hook
    // fast path is --arch, which skips this suite entirely.
    //
    // In an app with docs/spec/, check 10 loads the same route graph for the
    // screens view. Accepted rather than threaded through a SpecViewDescriptor
    // signature change: whichever runs first pays the module evaluation, and
    // the second call re-runs only the registrar (`load-routes.ts` documents
    // why nothing is re-evaluated).
    const sourceChanged = !changedFiles || [...changedFiles].some((file) => SOURCE_FILE_PATTERN.test(file))
    if (sourceChanged) {
      checks.push(...(await checkRouteContracts({ cwd, routesFile: options.routesFile })))

      // 7.8. Check the routes that declare `.agent()` metadata (RFC 0016):
      // the tool name is legal and unique, a non-read-only tool is covered by
      // authorization rather than merely authentication, and the schemas an
      // agent reads exist. Shares 7.7's gate for the same reason and pays the
      // same price: a third `loadRouteDefinitions()` in one process, which
      // re-runs only the registrar (see `load-routes.ts`) rather than
      // threading definitions through a signature change 7.7 deliberately
      // avoids. Content-activated inside — an app with no agent routes
      // contributes nothing and never scans a controller.
      checks.push(...(await checkAgentRoutes({ cwd, routesFile: options.routesFile })))
    }

    // 8. Check Postgres timestamp columns carry a time zone. Content-activated
    // and dialect-gated: apps with no schema, or a non-Postgres one, contribute
    // nothing. Not changed-filtered, like checks 6-7 — the schema is a handful
    // of files, so narrowing would hide a column an unrelated edit never
    // touched.
    const schemaTimestampResults = checkSchemaTimestamps(schemaTables)
    checks.push(...schemaTimestampResults)

    // 8.5. Check configureAttachments() binds a table the schema declares
    // (RFC 0013). The layer takes the table untyped (session-store
    // convention), so a renamed schema export only fails at runtime on the
    // first attach. Not changed-filtered, like check 8: the failure this
    // catches originates in db/schema.ts, not in the file holding the config
    // call, so filtering by the config file would hide exactly the schema
    // rename this exists for. The string pre-filter inside the check keeps
    // the full scan cheap.
    const attachmentsFiles = await discoverAttachmentsConfigFiles(cwd)
    checks.push(
      ...(await checkAttachmentsConfig({ cwd, cache, files: attachmentsFiles, schemaTables })),
    )

    // 8.6. The prior question: a model mixing in Attachable(...) in an app
    // with no configureAttachments() call at all. Same runtime-only failure
    // shape as 8.5, and content-activated the same way — apps without
    // Attachable models contribute nothing.
    checks.push(
      ...(await checkAttachableModels({ cwd, cache, files: allModelFiles, configFiles: attachmentsFiles })),
    )

    // 8.7. Delivery-route wiring (RFC 0015): a `delivery` config with no
    // registerAttachmentRoutes() route in the loaded definitions, and a
    // serve: 'redirect' disk whose storage driver can never presign. Both
    // failures are invisible at runtime by design (uniform 404s; a
    // fail-closed downgrade to proxy), so the static gate is the only
    // place they surface before traffic. Content-activated by the cheap
    // AST scan inside; gated like 7.7 under --changed because the wiring
    // half loads the app's route definitions — a deliberate divergence
    // from 8.5's not-filtered rule, accepted because sourceChanged is
    // only false on docs/lang-only runs.
    if (sourceChanged) {
      checks.push(
        ...(await checkAttachmentsDelivery({
          cwd,
          cache,
          files: attachmentsFiles,
          routesFile: options.routesFile,
        })),
      )
    }
  }

  // 9. Doc-link checks (docs/ frontmatter + @docs tags, RFC 0004). Runs in
  // plain mode and under --docs; content-activated, so apps without the
  // docs convention contribute zero results here.
  if (runs('docs')) {
    const docsResults = await runDocsCheck({ cwd, changedFiles, cache })
    checks.push(...docsResults)
  }

  // 10. Spec drift checks (docs/spec/ vs regenerated views, RFC 0004).
  // Content-activated like docs; under --changed it only regenerates when
  // a spec-relevant file changed.
  if (runs('spec')) {
    const specResults = await runSpecCheck({ cwd, routesFile: options.routesFile, changedFiles })
    checks.push(...specResults)
  }

  // 10.5. Translation catalog checks (lang/<locale>/*.json). Content-
  // activated like docs: apps without lang/ contribute zero results. Parity
  // is inherently whole-catalog, so --changed gates the suite as a unit:
  // skip when no lang/ file changed, run fully otherwise.
  if (runs('i18n')) {
    const langChanged =
      !changedFiles || [...changedFiles].some((file) => file === 'lang' || file.startsWith('lang/'))
    if (langChanged) {
      const i18nResults = await runI18nCheck({ cwd })
      checks.push(...i18nResults)
    }
  }

  // 11. Check architecture boundaries (guren.arch.ts + derived module rules)
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

/**
 * The name a local binding was imported under, for `import { posts as
 * postTable }`. A model may refer to its table by any local name, so the
 * schema's exported identifier has to be recovered before comparing the two.
 */
function importedNameOf(body: Statement[], local: string): string | undefined {
  for (const node of body) {
    if (node.type !== 'ImportDeclaration') continue
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.local.name !== local) continue
      if (specifier.imported.type === 'Identifier') return specifier.imported.name
    }
  }
  return undefined
}

/**
 * Checks the model against what it actually binds — the identifier passed to
 * `defineModel(x)` or assigned to `static table` — rather than a table name
 * guessed from the class name, which reported both false alarms (any model not
 * named after its table) and false clears (the guessed name matched a column
 * name or a comment).
 *
 * The two names being compared are written in different files, so an aliased
 * import is resolved back to the name the schema exports before matching —
 * otherwise every `import { posts as postTable }` would read as a missing
 * table.
 *
 * Two arms skip rather than warn, because neither one is evidence of a
 * problem: a model whose binding cannot be read (no supported spelling, or an
 * unparseable file), and a schema that declared no tables — missing,
 * unparsable, or written in one of the forms `parseSchemaTables` documents as
 * invisible. Note that the schema is parsed outside the `ParseCache`, so an
 * unparsable one is not reported by the `scan-coverage` check either; it is
 * silent here exactly as it already is for `checkSchemaTimestamps`.
 *
 * That skip is all-or-nothing, so a schema that declares some tables inline
 * and re-exports the rest (`export * from './posts'`) still warns on a model
 * bound to a re-exported one — the same blind spot the substring match had.
 */
async function checkModelTableBinding(
  cache: ParseCache,
  cwd: string,
  filePath: string,
  name: string,
  relPath: string,
  schemaTables: SchemaTable[],
): Promise<CheckResult[]> {
  const parsed = await cache.get(filePath)
  if (!parsed) return []

  const classDecl = firstClassDeclaration(parsed.ast.program.body)
  if (!classDecl) return []

  const identifier = extractTableIdentifier(classDecl)
  if (!identifier) return []

  // Scoped to the model's own app root: a module's models are checked against
  // `modules/<name>/db/schema.ts`, root models against the root schema.
  const moduleName = moduleNameFor(cwd, filePath)
  const tables = schemaTables.filter((table) => table.module === moduleName)
  if (tables.length === 0) return []

  const schemaPath = schemaPathFor(moduleName)
  // The model's own name for the table, and the schema's, which differ under
  // an aliased import.
  const exported = importedNameOf(parsed.ast.program.body, identifier) ?? identifier
  const bound = tables.find((table) => table.identifier === exported)
  const declaredAs = bound?.tableName ? ` as table '${bound.tableName}'` : ''
  const declared = formatTruncatedList(tables.map((table) => table.identifier))

  return [
    check(
      `model-schema:${name}`,
      `${name} schema`,
      bound ? 'pass' : 'warn',
      bound
        ? `${name} binds '${identifier}', declared in ${schemaPath}${declaredAs}.`
        : `${name} binds '${identifier}', but ${schemaPath} declares no such table.`,
      bound
        ? undefined
        : `Export a table named '${exported}' from ${schemaPath}, or point ${name} at one it declares (${declared}).`,
      relPath,
    ),
  ]
}

/**
 * Mass-assignment definition checks (AST-based via the shared ParseCache, so
 * comments, access modifiers, and type annotations neither hide a declaration
 * nor fake one).
 *
 * `guarded` and `strictFillable` no longer exist as Model API — a model
 * declaring them ships dead-looking protection that TypeScript accepts
 * silently (agents reproducing older patterns are the likely authors), so
 * the declaration itself is an error, not a warning.
 *
 * A fillable list naming a denied credential column is a contradiction that
 * otherwise only surfaces at the first write: the field throws regardless.
 * The denied set's inputs are parseable statics (passwordHashField /
 * rememberTokenField, defaulting to passwordHash / rememberToken), so it is
 * resolved here the same way the model resolves it at runtime.
 */
async function checkMassAssignmentConfig(
  cache: ParseCache,
  filePath: string,
  name: string,
  relPath: string,
): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const parsed = await cache.get(filePath)
  if (!parsed) return results

  const classDecl = firstClassDeclaration(parsed.ast.program.body)
  if (!classDecl) return results

  const legacy = ['guarded', 'strictFillable'].filter((property) => findStaticClassProperty(classDecl, property))
  if (legacy.length > 0) {
    results.push(
      check(
        `mass-assignment-legacy:${name}`,
        `${name} legacy mass-assignment config`,
        'fail',
        `${name} declares ${legacy.join(' and ')}, which no longer exist as Model API — the declaration is inert.`,
        `Delete the ${legacy.join('/')} declaration. The primary key and credential columns are protected by `
        + `the framework; any OTHER field the old guarded list carried (e.g. tenantId, isAdmin) is now `
        + `mass-assignable — declare 'static fillable = [...]' without those fields to keep them protected.`,
        relPath,
      ),
    )
  }

  if (classUsesAuthenticatableBase(classDecl)) {
    const fillable = resolveModelStringArrayConfig(classDecl, 'fillable')
    if (fillable) {
      const passwordField = staticStringProperty(classDecl, 'passwordField') ?? 'password'
      const hashField = staticStringProperty(classDecl, 'passwordHashField') ?? 'passwordHash'
      const rememberField = staticStringProperty(classDecl, 'rememberTokenField') ?? 'rememberToken'
      const denied = [...(hashField !== passwordField ? [hashField] : []), rememberField]
      const contradictions = fillable.filter((field) => denied.includes(field))
      if (contradictions.length > 0) {
        results.push(
          check(
            `mass-assignment-denied:${name}`,
            `${name} fillable lists denied columns`,
            'fail',
            `${name} lists ${contradictions.map((f) => `'${f}'`).join(', ')} in fillable, but credential columns `
            + `can never be mass-assigned — every create()/update() carrying them will throw.`,
            `Remove ${contradictions.map((f) => `'${f}'`).join(', ')} from fillable. Pass a plain password and let `
            + `the model hash it, or use forceCreate()/forceUpdate() for trusted server-side values.`,
            relPath,
          ),
        )
      }
    }
  }

  return results
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
