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
  extractTableIdentifier,
  findStaticClassProperty,
  firstClassDeclaration,
  resolveModelStringArrayConfig,
  staticStringProperty,
} from './model-parser'
import { emptyActions } from './controller-methods'
import { checkConsoleCommandRegistration } from './console-check'
import { checkRoutePathParams, discoverRoutePathFiles } from './route-path-check'
import { affectsRouteWiring, checkRouteRegistrarWiring } from './routes-check'
import { checkRouteContracts } from './route-contract-check'
import { checkAgentRoutes } from './agent-route-check'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { resolveRoutesEntry } from './route-registrar'
import type { RouteDefinition } from '@guren/core'

/**
 * Any file that could hold a route's params schema — which is any importable
 * source file, since a schema is usually imported into `routes/` from elsewhere.
 */
const SOURCE_FILE_PATTERN = /\.(ts|tsx|mts|js|jsx|mjs)$/
import { checkSchemaTimestamps } from './schema-check'
import {
  checkAttachableModels,
  checkAttachmentsConfig,
  checkAttachmentsDelivery,
  checkAttachmentsPublicDisk,
  discoverAttachmentsConfigFiles,
} from './attachments-check'
import { checkAgentsConfig, type AgentsConfigExpansion } from './agents-config-check'
import { parseSchemaTables, schemaPathFor, type SchemaTable } from './schema-parser'
import { ParseCache } from './parse-cache'
import { extractInertiaPageRefs, resolveInertiaPageFile, expectedInertiaPagePath } from './inertia-pages'
import { describePageManifestSuppression, PAGES_MANIFEST_FILE, planPageManifest } from './pages-types'
import { AGENTS_MANIFEST_FILE, planAgentManifest } from './agents-types'
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
   * rules). Fast path for the agent-harness edit hook.
   */
  arch?: boolean
  /**
   * Restrict file-scanning checks to files changed vs. the merge base with main,
   * plus uncommitted/untracked ones; checks everything outside a git repo.
   * Translation parity and route registrar wiring answer a whole-directory
   * question, so `--changed` gates each as a unit rather than filtering inputs.
   */
  changed?: boolean
  /** Run doc-link checks only (docs/ frontmatter + @docs tags). */
  docs?: boolean
  /** Run spec drift checks only (docs/spec/ vs regenerated views). */
  spec?: boolean
  /**
   * Run translation catalog checks only (lang/<locale>/*.json key and
   * placeholder parity). Content-activated: apps without lang/ contribute none.
   */
  i18n?: boolean
}

/**
 * The `guren codegen` invocation that regenerates the artifacts *this* check
 * read — carrying `--routes` when the caller passed one. Without it, a
 * `guren check --routes routes/api.ts` prints a remedy that reads the codegen
 * default instead, and writes or deletes the manifest from the wrong graph.
 */
function codegenCommandFor(routesFile?: string): string {
  if (routesFile === undefined) return 'bunx guren codegen'
  // Quoted only when it would not survive a shell word-split, so the ordinary
  // `routes/api.ts` stays copy-pasteable as written.
  const argument = /^[\w./@-]+$/u.test(routesFile) ? routesFile : `'${routesFile.replace(/'/gu, `'\\''`)}'`
  return `bunx guren codegen --routes ${argument}`
}

/**
 * The agent manifest's own presence check (RFC 0016), which the generic manifest
 * loop cannot express: `.guren/agents.gen.ts` is expected only when the
 * derivation yields a tool, and an existing one is *wrong* when it does not —
 * `guren codegen` deletes it. Both states point at the same command.
 */
async function checkAgentManifest(
  cwd: string,
  routesFile?: string,
  definitions?: RouteDefinition[],
): Promise<CheckResult> {
  const key = `manifest:${AGENTS_MANIFEST_FILE}`
  const plan = await planAgentManifest(cwd, routesFile, definitions)
  const codegen = codegenCommandFor(routesFile)

  if (plan.reason === 'unreadable') {
    return check(
      key,
      AGENTS_MANIFEST_FILE,
      'warn',
      `Skipped: the route graph failed to load: ${plan.loadError}`,
      'Fix the error, then run: bunx guren check',
      routesFile,
    )
  }

  if (plan.staleManifest) {
    return check(
      key,
      AGENTS_MANIFEST_FILE,
      'warn',
      `${AGENTS_MANIFEST_FILE} describes agent tools this app no longer exposes — no route derives one.`,
      `Run: ${codegen} (it removes ${AGENTS_MANIFEST_FILE})`,
    )
  }

  if (plan.reason === 'no-tools') {
    return check(
      key,
      AGENTS_MANIFEST_FILE,
      'pass',
      `No route declares agent metadata; ${AGENTS_MANIFEST_FILE} is not applicable.`,
    )
  }

  const present = await fileExists(cwd, AGENTS_MANIFEST_FILE)
  return check(
    key,
    AGENTS_MANIFEST_FILE,
    present ? 'pass' : 'warn',
    present
      ? `${AGENTS_MANIFEST_FILE} is present (${plan.toolCount} ${plan.toolCount === 1 ? 'tool' : 'tools'}).`
      : `${AGENTS_MANIFEST_FILE} is missing; ${plan.toolCount} ${plan.toolCount === 1 ? 'route derives' : 'routes derive'} an agent tool.`,
    present ? undefined : `Run: ${codegen}`,
  )
}

/**
 * The app's registered route definitions, or the reason they could not be loaded
 * — never a throw, and never an empty list standing in for a failure. An absent
 * routes file is neither: an app mid-scaffold is a legitimate shape.
 */
async function loadRouteGraph(
  cwd: string,
  routesFile: string,
): Promise<{ definitions?: RouteDefinition[]; error?: string }> {
  if (!(await fileExists(cwd, routesFile))) return {}

  try {
    return { definitions: await loadRouteDefinitions(resolve(cwd, routesFile), cwd) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Verifies every `modules/<name>/db/schema.ts` is re-exported from the project's
 * root `db/schema.ts` (RFC 0002). A project without a root `db/schema.ts` warns
 * rather than fails, since not every app uses a database.
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
  // Whether any changed file could affect what the app's modules evaluate to:
  // the shared gate for every check that loads the route graph (5.5, 7.7, 8.7).
  const sourceChanged = !changedFiles || [...changedFiles].some((file) => SOURCE_FILE_PATTERN.test(file))

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

  // Undefined until the agent-registry check runs and finds a registry, so a
  // JSON consumer can tell "this app hosts no agents" from "it hosts agents
  // whose scopes expand to nothing".
  let agentScopeExpansions: AgentsConfigExpansion[] | undefined

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

    // 3. Check each model binds a table its schema declares. The unfiltered list
    // is kept for check 8.6, which is deliberately not changed-filtered.
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
    // one of them is codegen's call, not this file's (see planPageManifest).
    const pagesPlan = await planPageManifest(cwd)
    // The manifest list below drops the file on this branch, so without this
    // nothing would report one left on disk importing a package the app does not
    // have — the state that actually fails the typecheck.
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

    // 5.5. The agent manifest cannot ride the loop above: codegen writes it only
    // for apps deriving a tool and *removes* it otherwise (see planAgentManifest).
    // The graph is loaded once here for 5.5, 7.7, 7.8 and 8.7 — two loads could
    // resolve different routes entries and disagree about what the app mounted.
    // The entry is probed: the API-only template ships routes/api.ts only.
    const routeGraphFile = options.routesFile ?? (await resolveRoutesEntry(cwd)) ?? DEFAULT_ROUTES_FILE
    let graph: Awaited<ReturnType<typeof loadRouteGraph>> | undefined
    if (sourceChanged) {
      graph = await loadRouteGraph(cwd, routeGraphFile)
      if (graph.error) {
        checks.push(
          check(
            'route-graph',
            'Route graph',
            'warn',
            `Skipped: the route graph failed to load: ${graph.error}. Agent manifest, route contract `
            + 'and agent-route checks did not run.',
            'Fix the error, then run: bunx guren check',
            routeGraphFile,
          ),
        )
      } else {
        checks.push(await checkAgentManifest(cwd, options.routesFile, graph.definitions))
      }
    }

    // 6. Check every module's db/schema.ts is re-exported from the root
    // db/schema.ts, for modules created or edited by hand.
    const schemaAggregationResults = await checkModuleSchemaAggregation(cwd)
    checks.push(...schemaAggregationResults)

    // 7. Check every console command is registered with a kernel, for commands
    // written or moved by hand. Content-activated.
    const commandRegistrationResults = await checkConsoleCommandRegistration(cwd, cache)
    checks.push(...commandRegistrationResults)

    // 7.5. Check every routes file's registrar is reached from the entry
    // registrar that would mount it — the app's for `routes/`, the one
    // `defineModule({ routes })` names for `modules/<name>/routes/`; otherwise the
    // only symptom is a 404. Gated as a unit under --changed: see
    // checkRouteRegistrarWiring for why filtering by changed *candidate* misses the breaking edit.
    const routesChanged =
      !changedFiles || [...changedFiles].some((file) => affectsRouteWiring(file, options.routesFile))
    if (routesChanged) {
      const routeWiringResults = await checkRouteRegistrarWiring({ cwd, cache, routesFile: options.routesFile })
      checks.push(...routeWiringResults)

      // 7.6. Check route paths for `:name*`, which reads as a wildcard and is
      // not one — Hono registers a single-segment parameter named literally
      // `name*`. A per-file question, so changed-*filtered*; it shares 7.5's
      // gate because `affectsRouteWiring` covers every file this reads.
      const routePathFiles = filterChanged(await discoverRoutePathFiles(cwd, options.routesFile))
      checks.push(...(await checkRoutePathParams({ cwd, cache, files: routePathFiles })))
    }

    // 7.7. Check each route's `params` schema keys and `bind` keys against the parameters
    // its path declares. Runs on loaded definitions, not the AST: the registered path is
    // the joined one (group prefixes, resource expansions), and a params schema is usually
    // imported from elsewhere — any source file, so `--changed` gates on `sourceChanged`
    // rather than 7.5's `routesChanged`. A load failure was already reported at 5.5.
    if (graph?.definitions) {
      const definitions = graph.definitions
      checks.push(...(await checkRouteContracts({ cwd, routesFile: routeGraphFile, definitions })))

      // 7.8. Check the routes that declare `.agent()` metadata (RFC 0016): the
      // tool name is legal and unique, a non-read-only tool is covered by
      // authorization rather than merely authentication, and the schemas an
      // agent reads exist. Shares 7.7's gate; content-activated inside.
      checks.push(
        ...(await checkAgentRoutes({ cwd, routesFile: routeGraphFile, definitions, cache })),
      )
    }

    // 7.9. The agent registry (RFC 0017 §3), read as source because
    // `guren cloudflare:build` reads it that way: a spread or a non-literal
    // `module` is valid TypeScript that leaves the worker with no agents to
    // export. Content-activated, and it reuses 7.7's definitions rather than
    // importing an application for the tool-existence warning.
    const registry = await checkAgentsConfig({
      cwd,
      cache,
      ...(graph?.definitions ? { definitions: graph.definitions } : {}),
    })
    checks.push(...registry.checks)
    agentScopeExpansions = registry.expansions

    // 8. Check Postgres timestamp columns carry a time zone. Content-activated
    // and dialect-gated. Not changed-filtered: the schema is a handful of files,
    // so narrowing would hide a column an unrelated edit never touched.
    const schemaTimestampResults = checkSchemaTimestamps(schemaTables)
    checks.push(...schemaTimestampResults)

    // 8.5. Check configureAttachments() binds a table the schema declares (RFC
    // 0013); the layer takes it untyped, so a renamed export only fails on the
    // first attach. Not changed-filtered: the failure originates in db/schema.ts,
    // so filtering by the config file would hide the rename this exists for.
    const attachmentsFiles = await discoverAttachmentsConfigFiles(cwd)
    checks.push(
      ...(await checkAttachmentsConfig({ cwd, cache, files: attachmentsFiles, schemaTables })),
    )

    // 8.6. The prior question: a model mixing in Attachable(...) in an app with
    // no configureAttachments() call at all. Same runtime-only failure as 8.5.
    checks.push(
      ...(await checkAttachableModels({ cwd, cache, files: allModelFiles, configFiles: attachmentsFiles })),
    )

    // 8.65. The attachments disk rooted inside the statically served public/
    // tree, where uploaded bytes are reachable as static assets. Not
    // changed-filtered: the two halves of the finding live in different files
    // (the config names the disk, the storage provider roots it).
    checks.push(
      ...(await checkAttachmentsPublicDisk({ cwd, cache, files: attachmentsFiles })),
    )

    // 8.7. Delivery-route wiring (RFC 0015): a `delivery` config with no
    // registerAttachmentRoutes() route in the loaded definitions, and a
    // serve: 'redirect' disk whose driver can never presign. Both are invisible
    // at runtime by design (uniform 404s; a fail-closed downgrade to proxy).
    // Gated like 7.7, since the wiring half reads the route definitions.
    if (sourceChanged) {
      checks.push(
        ...(await checkAttachmentsDelivery({
          cwd,
          cache,
          files: attachmentsFiles,
          routesFile: routeGraphFile,
          definitions: graph?.definitions,
        })),
      )
    }
  }

  // 9. Doc-link checks (docs/ frontmatter + @docs tags, RFC 0004).
  // Content-activated: apps without the docs convention contribute nothing.
  if (runs('docs')) {
    const docsResults = await runDocsCheck({ cwd, changedFiles, cache })
    checks.push(...docsResults)
  }

  // 10. Spec drift checks (docs/spec/ vs regenerated views, RFC 0004). Under
  // --changed it only regenerates when a spec-relevant file changed.
  if (runs('spec')) {
    const specResults = await runSpecCheck({ cwd, routesFile: options.routesFile, changedFiles })
    checks.push(...specResults)
  }

  // 10.5. Translation catalog checks (lang/<locale>/*.json). Parity is
  // inherently whole-catalog, so --changed gates the suite as a unit.
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

  // Every checker treats an unparsable file as contributing nothing, which is
  // indistinguishable from a file with nothing wrong. Reported once here, after
  // every suite has finished asking the cache.
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
    ...(agentScopeExpansions ? { agentScopes: agentScopeExpansions } : {}),
  }

  return report
}

/**
 * The exported name behind a local binding, for `import { posts as postTable }`.
 * A model may refer to its table by any local name.
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
 * `defineModel(x)` or assigned to `static table` — with an aliased import resolved
 * back to the name the schema exports. An unreadable binding and a schema declaring
 * no tables both skip rather than warn (an unparsable schema is parsed outside the
 * `ParseCache`, so `scan-coverage` misses it too); a partly re-exporting schema still warns.
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
 * Mass-assignment definition checks, AST-based so comments, access modifiers and
 * type annotations neither hide a declaration nor fake one. `guarded` and
 * `strictFillable` are not Model API, and TypeScript accepts the dead declaration
 * silently, so declaring one is an error. A fillable list naming a denied credential
 * column is the other contradiction: the field throws on every write regardless.
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

  for (const { className, name } of emptyActions(parsed.ast, filePath)) {
    results.push(
      check(
        `empty-method:${className}.${name}`,
        `${className}.${name}()`,
        'warn',
        `Method ${name}() has an empty body.`,
        `Implement ${className}.${name}() in ${relPath}.`,
        relPath,
      ),
    )
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
