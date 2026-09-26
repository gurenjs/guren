import { resolve, relative } from 'node:path'
import { consola } from 'consola'
import type { Statement } from '@babel/types'
import {
  FileDiscoveryError,
  discoverAppConfigFiles,
  discoverControllerFiles,
  discoverModelFiles,
  fileExists,
  hasControllerTest,
  describeControllerTestMiss,
  classNameFromPath,
  toPosixRelative,
  listAppRoots,
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
import { checkDeferredProps } from './deferred-props-check'
import { checkAiAgents } from './ai-agent-check'
import { checkSessionsConfig, readSessionWiring } from './sessions-check'
import { checkPrototypeRoutes } from './prototype-check'
import { checkDeployRuntime } from './deploy-runtime'
import { loadRouteDefinitions } from './load-routes'
import { DEFAULT_ROUTES_FILE, routesEntryOrDefault } from './route-registrar'
import type { RouteDefinition } from '@guren/server'

import { checkSchemaTimestamps } from './schema-check'
import {
  checkAttachableModels,
  checkAttachmentsConfig,
  checkAttachmentsDelivery,
  checkAttachmentsPublicDisk,
  readAttachmentsWiring,
} from './attachments-check'
import { checkAgentsConfig, type AgentsConfigExpansion } from './agents-config-check'
import { declaredTableIdentifiers, findSchemaAggregate, moduleSchemaAggregateName, moduleSchemaSpecifier, parseSchemaTables, schemaPathFor, type SchemaTable } from './schema-parser'
import { reExportedSchemaModules } from './schema-binding'
import { ParseCache } from './parse-cache'
import { extractInertiaPageRefs, resolveInertiaPageFile, expectedInertiaPagePath } from './inertia-pages'
import { describePageManifestSuppression, PAGES_MANIFEST_FILE, planPageManifest } from './pages-types'
import { AGENTS_MANIFEST_FILE, planAgentManifest, STALE_AGENT_MANIFEST_MESSAGE } from './agents-types'
import { runArchCheck } from './arch-check'
import { runDocsCheck } from './docs-check'
import { runI18nCheck } from './i18n-check'
import { introspectRunner, type Introspection, type IntrospectOption } from './introspect'
import { INTROSPECTION_UNAVAILABLE, INTROSPECTION_UNAVAILABLE_FIX, introspectionUnavailableMessage, NO_SOURCE_CHANGED_REASON, ROUTES_FLAG_NOT_INTROSPECTED } from './manifest-section'
import { checkEnvExample, ENV_EXAMPLE_FILE } from './app-env'
import { checkConfigWiring } from './config-check'
import { runSpecCheck } from './spec-check'
import { checkPlans, isPlanInput } from './plan-check'
import { changesSource, getChangedFiles } from './changed-files'
import { check, formatFixCommand, routesCommandFix, type CheckFix, type CheckResult, type CheckReport, type CheckStatus } from './check-result'

export type { CheckStatus, CheckResult, CheckReport }

/** The suites a flag of the same name selects. */
export const CHECK_SUITES = ['arch', 'docs', 'spec', 'i18n', 'prototype', 'env', 'plan'] as const
export type CheckSuite = (typeof CHECK_SUITES)[number]

/**
 * Why `check --ci` refuses the suite flags it was given. A suite flag would narrow the gate;
 * `--plan` is advisory and never part of it, so it is named apart from the gating suites.
 */
export function ciSuiteConflict(given: readonly CheckSuite[]): string {
  const gating = CHECK_SUITES.filter((suite) => suite !== 'plan')
  const parts: string[] = []
  if (given.some((suite) => suite !== 'plan')) parts.push(`check --ci runs the full suite: drop ${gating.map((suite) => `--${suite}`).join('/')} (they gate on their own)`)
  if (given.includes('plan')) parts.push('--plan is advisory and never part of check --ci; run guren check --plan on its own')
  return `${parts.join('. ')}.`
}

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
  /** The changed set a caller already computed (`null` = don't filter); takes precedence over `changed`. */
  changedFiles?: Set<string> | null
  /** Run doc-link checks only (docs/ frontmatter + @docs tags). */
  docs?: boolean
  /** Run spec drift checks only (docs/spec/ vs regenerated views). */
  spec?: boolean
  /**
   * Run translation catalog checks only (lang/<locale>/*.json key and
   * placeholder parity). Content-activated: apps without lang/ contribute none.
   */
  i18n?: boolean
  /** Run prototype wiring checks only (RFC 0021 §5): fixture entries against the route graph. */
  prototype?: boolean
  /** Run the `.env.example` against `config/env.ts` check only (RFC 0027 §7). Content-activated. */
  env?: boolean
  /** Run the implementation-plan checks (RFC 0030 §8). Advisory, and never part of a run without this flag. */
  plan?: boolean
  /**
   * Read the introspected app where a check can (RFC 0026 §5). `guren check` and `plan:verify`
   * set it; the gate passes a run it shares with its audit stage. The edit hook and the dev MCP
   * server leave it off, and their checks with no static path report `-unverified`.
   */
  introspect?: IntrospectOption
}

/**
 * The `guren codegen` invocation that regenerates the artifacts *this* check
 * read — carrying `--routes` for any entry other than codegen's default. Without
 * it, the remedy reads routes/web.ts instead, and writes or deletes the manifest
 * from the wrong graph (or, on an API-only app, skips it and exits 0).
 */
function codegenFix(routesFile?: string): CheckFix {
  return routesCommandFix('codegen', routesFile)
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
  const fix = codegenFix(routesFile)
  const codegen = formatFixCommand(fix)

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
    return {
      ...check(
        key,
        AGENTS_MANIFEST_FILE,
        'warn',
        STALE_AGENT_MANIFEST_MESSAGE,
        `Run: ${codegen} (it removes ${AGENTS_MANIFEST_FILE})`,
      ),
      fix,
    }
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
  if (present) {
    return check(
      key,
      AGENTS_MANIFEST_FILE,
      'pass',
      `${AGENTS_MANIFEST_FILE} is present (${plan.toolCount} ${plan.toolCount === 1 ? 'tool' : 'tools'}).`,
    )
  }
  return {
    ...check(
      key,
      AGENTS_MANIFEST_FILE,
      'warn',
      `${AGENTS_MANIFEST_FILE} is missing; ${plan.toolCount} ${plan.toolCount === 1 ? 'route derives' : 'routes derive'} an agent tool.`,
      `Run: ${codegen}`,
    ),
    fix,
  }
}

/**
 * The app's registered route definitions, or the reason they could not be loaded
 * — never a throw, and never an empty list standing in for a failure. An absent
 * routes file is neither: an app mid-scaffold is a legitimate shape.
 */
async function loadRouteGraph(
  cwd: string,
  routesFile: string,
): Promise<{ definitions: RouteDefinition[]; error?: undefined } | { definitions?: undefined; error?: string }> {
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
async function checkModuleSchemaAggregation(cwd: string, cache: ParseCache): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const rootSchemaPath = schemaPathFor(null)
  const rootFile = resolve(cwd, rootSchemaPath)
  const rootExists = await fileExists(cwd, rootSchemaPath)
  const outcome = rootExists ? await cache.read(rootFile) : null
  const reExported = outcome?.status === 'parsed' ? reExportedSchemaModules(cwd, rootFile, outcome.ast.program.body) : null

  for (const moduleName of await listModuleNames(cwd)) {
    const moduleSchemaPath = schemaPathFor(moduleName)
    if (!(await fileExists(cwd, moduleSchemaPath))) continue

    const reExport = `export * from '${moduleSchemaSpecifier(moduleName)}'`
    const id = `module-schema-aggregation:${moduleName}`
    const label = `${moduleName} schema aggregation`

    if (!rootExists) {
      results.push(check(id, label, 'warn', `${moduleSchemaPath} exists but there is no root ${rootSchemaPath} to re-export it from.`, `Create ${rootSchemaPath} and add: ${reExport}`))
    } else if (!reExported) {
      results.push(check(id, label, 'warn', `${rootSchemaPath} does not parse, so whether it re-exports ${moduleSchemaPath} is unknown.`))
    } else if (reExported.has(moduleName)) {
      results.push(check(id, label, 'pass', `${rootSchemaPath} re-exports ${moduleSchemaPath}.`))
    } else {
      results.push(check(id, label, 'warn', `${rootSchemaPath} does not re-export ${moduleSchemaPath}.`, `Add to ${rootSchemaPath}: ${reExport}`))
    }
  }

  return results
}

/**
 * A hand-kept aggregate object (`export const schema = { posts, users }`) missing a table its
 * file declares or, for the root's, a module table it neither lists nor spreads. Gating only
 * where the file identifies the object (`findSchemaAggregate`'s `confident`): on a shape match
 * alone the report is a guess, and an app's own grouping must not turn CI red. Content-activated.
 */
async function checkSchemaAggregateKeys(cwd: string, cache: ParseCache): Promise<CheckResult[]> {
  // Roots, not `schemaTables`: a table whose columns are passed as an identifier is one
  // `declaredTableIdentifiers` keeps and `parseSchemaTables` drops, and a file holding only
  // those would never be visited. `read()`, so a root with no schema records no skip.
  const parsed = (await Promise.all((await listAppRoots(cwd)).map(async ({ module }) => {
    const relPath = schemaPathFor(module)
    const file = resolve(cwd, relPath)
    const outcome = await cache.read(file)
    return outcome.status === 'parsed' ? { module, relPath, location: { cwd, file }, ast: outcome.ast } : null
  }))).filter((entry) => entry !== null)

  const root = parsed.find((entry) => entry.module === null)
  const rootAggregate = root ? findSchemaAggregate(root.ast, { location: root.location }) : null

  const schemas = parsed.map((entry) => {
    const spread = entry.module === null || !rootAggregate?.confident ? undefined : rootAggregate.delegated.get(entry.module)
    // A namespace spread hands the root every table the module exports, so no module object is
    // what drizzle is handed.
    if (spread === '') return { ...entry, aggregate: null, declared: new Set<string>(), unreadable: undefined }
    // The root object spreading a module's export is what identifies that export as the module's aggregate.
    const aggregate = entry.module === null ? rootAggregate : findSchemaAggregate(entry.ast, { location: entry.location, identifiedAs: spread })
    const unreadable = spread !== undefined && aggregate?.name !== spread ? spread : undefined
    return { ...entry, aggregate: unreadable ? null : aggregate, declared: aggregate?.declared ?? declaredTableIdentifiers(entry.ast), unreadable }
  })

  // Only the root's object is the one drizzle is handed; a module's lists its own tables. A
  // spread whose object this reader cannot follow covers nothing it can confirm.
  const moduleGaps = !rootAggregate ? [] : schemas.flatMap(({ module, relPath, declared, unreadable }) => {
    if (module === null || (rootAggregate.delegated.has(module) && !unreadable)) return []
    const listed = rootAggregate.listed.get(module)
    const missing = [...declared].filter((name) => !listed?.has(name))
    return missing.length === 0 ? [] : [{ module, relPath, missing, unreadable }]
  })

  const results: CheckResult[] = []
  for (const { module, relPath, aggregate, unreadable } of schemas) {
    if (unreadable) {
      results.push({
        ...check(
          `schema-aggregate-keys:${module}`,
          `${module} schema object`,
          'warn',
          `${unreadable} in ${relPath}, which the root schema object spreads, is not an object of table references this check can read, so which tables it carries is unverified.`,
          `List each table as a shorthand key in ${unreadable}, with no spread, computed key or call.`,
        ),
        advisory: true,
      })
    }
    if (!aggregate) continue

    const own = [...aggregate.declared].filter((name) => !aggregate.keys.includes(name))
    const fromModules = module === null ? moduleGaps : []
    const scope = module ?? 'app'
    const missing = [...own, ...fromModules.flatMap((gap) => gap.missing.map((name) => `${name} (${gap.relPath})`))]
    const complete = missing.length === 0
    // Tables behind an unreadable spread may be there, so their gap is advisory on its own.
    const unverifiedOnly = !complete && own.length === 0 && fromModules.every((gap) => gap.unreadable)

    // The fix splits on the same evidence the writer does: on a shape match alone no
    // scaffolder will add the key either, so it names what would make them.
    const fixes: string[] = []
    if (!aggregate.confident) {
      fixes.push(`Nothing identifies this object as the schema, so scaffolders leave it alone: name it \`schema\` or read it in a \`typeof\` to have them keep it current, or add ${missing.join(', ')} by hand.`)
    } else {
      if (own.length > 0) fixes.push(`Add ${own.join(', ')} to it, keeping each table's own declaration above the object.`)
      for (const gap of fromModules) {
        if (gap.unreadable) {
          fixes.push(`It spreads ${gap.unreadable} from ${gap.relPath}, which this check cannot read (see the ${gap.module} schema object).`)
          continue
        }
        const identifier = moduleSchemaAggregateName(gap.module)
        fixes.push(`Keep ${gap.relPath}'s tables in its own \`export const ${identifier} = { … }\` and spread it into this object (\`...${identifier}\`, imported from '${moduleSchemaSpecifier(gap.module)}'), or import ${gap.missing.join(', ')} from there and list them here.`)
      }
    }

    results.push({
      ...check(
        `schema-aggregate-keys:${scope}`,
        `${scope} schema object`,
        complete ? 'pass' : 'warn',
        complete
          ? `The schema object in ${relPath} lists every table ${module === null ? 'the app declares' : 'the file declares'}.`
          : `The schema object in ${relPath} does not ${unverifiedOnly ? 'verifiably ' : ''}list ${formatTruncatedList(missing)}.`,
        complete ? undefined : fixes.join(' '),
      ),
      advisory: !aggregate.confident || unverifiedOnly,
    })
  }

  return results
}

/**
 * The one line a failed introspection leaves in the report (RFC 0026 §5), whichever
 * check started it: those checks fell back to source and say so in `evidence`.
 */
async function introspectionUnavailable(run: Promise<Introspection> | undefined): Promise<CheckResult | undefined> {
  const result = await run
  if (result?.status !== 'failed') return undefined
  return {
    ...check(
      INTROSPECTION_UNAVAILABLE,
      'Introspection',
      'warn',
      introspectionUnavailableMessage(result, 'The checks with a source reading were judged from it; the rest report -unverified.'),
      INTROSPECTION_UNAVAILABLE_FIX,
    ),
    advisory: true,
  }
}

export async function runCheck(options: RunCheckOptions = {}): Promise<CheckReport> {
  try {
    return await collectCheckReport(options)
  } catch (error) {
    if (!(error instanceof FileDiscoveryError)) throw error
    const cwd = resolve(options.cwd ?? process.cwd())
    return {
      cwd,
      checks: [{
        ...check('discovery:read', 'Scan incomplete', 'fail', error.message,
          'Fix the directory or its permissions and run the check again.', toPosixRelative(cwd, error.directory)),
        evidence: 'none',
      }],
      passCount: 0, warnCount: 0, failCount: 1,
    }
  }
}

async function collectCheckReport(options: RunCheckOptions): Promise<CheckReport> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const checks: CheckResult[] = []
  const cache = new ParseCache()

  const changedFiles = options.changedFiles !== undefined ? options.changedFiles : options.changed ? await getChangedFiles(cwd) : null
  const filterChanged = (files: string[]): string[] =>
    changedFiles ? files.filter((f) => changedFiles.has(toPosixRelative(cwd, f))) : files
  // Whether any changed file could affect what the app's modules evaluate to:
  // the shared gate for every check that loads the route graph or executes the app (5.5, 7.7, 8.7).
  const sourceChanged = changesSource(changedFiles)

  // `--arch` / `--docs` / `--spec` select suites; combining them runs the
  // union (never silently nothing). No flag = every suite.
  const selected = new Set<CheckSuite>(CHECK_SUITES.filter((suite) => options[suite]))
  const runs = (suite: 'core' | CheckSuite): boolean =>
    selected.size === 0 || (suite !== 'core' && selected.has(suite))

  // Undefined until the agent-registry check runs and finds a registry, so a
  // JSON consumer can tell "this app hosts no agents" from "it hosts agents
  // whose scopes expand to nothing".
  let agentScopeExpansions: AgentsConfigExpansion[] | undefined
  // Loaded once by the core suite and reused by the prototype suite, which
  // loads it itself only when running alone.
  let graph: Awaited<ReturnType<typeof loadRouteGraph>> | undefined
  // One introspection per run, started only by a check that reads the manifest.
  let introspection: Promise<Introspection> | undefined
  const run = introspectRunner(cwd, options.introspect)
  const introspect = run ? () => (introspection ??= run()) : undefined
  // The deploy verdicts start before the suites so their introspection child overlaps them,
  // whenever package.json or any source could have moved: the verdict joins the two.
  const deployRuntime =
    runs('core') && (sourceChanged || changedFiles?.has('package.json'))
      ? checkDeployRuntime(cwd, { introspect: introspect ?? false })
      : undefined
  // Awaited at step 12; until then a rejection must not surface as unhandled.
  deployRuntime?.catch(() => {})
  // The session and attachments rules (8.5-8.7) introspect once they find their config, started here for
  // the same overlap. Gated like 7.7: a run that changed no source must not execute the app.
  const wiringIntrospect = introspect && !sourceChanged ? { skipped: NO_SOURCE_CHANGED_REASON } : introspect
  // The route rules (7.7, 7.8, 10.6) judge the manifest's routes, which describe the entry, not a file `--routes` names.
  const routeIntrospect = wiringIntrospect && options.routesFile ? { skipped: ROUTES_FLAG_NOT_INTROSPECTED } : wiringIntrospect
  const appConfigFiles = runs('core') ? discoverAppConfigFiles(cwd) : undefined
  const sessionWiring = appConfigFiles?.then((files) => readSessionWiring(cwd, cache, files, wiringIntrospect))
  const attachmentsWiring = appConfigFiles?.then((files) => readAttachmentsWiring(cwd, cache, files, wiringIntrospect))
  sessionWiring?.catch(() => {})
  attachmentsWiring?.catch(() => {})

  if (runs('core')) {
    // 1. Check controllers for empty methods. The unfiltered list is kept for
    // check 2.5, which is deliberately not changed-filtered.
    const allControllerFiles = await discoverControllerFiles(cwd)
    const controllerFiles = filterChanged(allControllerFiles)
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

    // 2.5. A `defer()` prop the page declares as required: the page's `Props` is
    // independent of the controller's type, so it typechecks and the initial visit
    // hands the component undefined. Not changed-filtered: the controller defers
    // and the page declares, and either file can be the one that changed.
    checks.push(...(await checkDeferredProps({ cwd, cache, files: allControllerFiles })))

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
    // The entry is probed: the API-only template ships routes/api.ts only. codegen
    // itself defaults to routes/web.ts, so its fix has to name any other entry.
    const routeGraphFile = await routesEntryOrDefault(cwd, options.routesFile)
    const codegenRoutes = options.routesFile ?? (routeGraphFile === DEFAULT_ROUTES_FILE ? undefined : routeGraphFile)
    const manifestFix = codegenFix(codegenRoutes)
    for (const manifest of manifests) {
      if (await fileExists(cwd, manifest)) {
        checks.push(check(`manifest:${manifest}`, manifest, 'pass', `${manifest} is present.`))
        continue
      }
      checks.push({
        ...check(`manifest:${manifest}`, manifest, 'warn', `${manifest} is missing.`, `Run: ${formatFixCommand(manifestFix)}`),
        fix: manifestFix,
      })
    }

    // 5.5. The agent manifest cannot ride the loop above: codegen writes it only
    // for apps deriving a tool and *removes* it otherwise (see planAgentManifest).
    // The graph is loaded once here for 5.5, 7.7 and 7.8 — two loads could
    // resolve different routes entries and disagree about what the app mounted.
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
        checks.push(await checkAgentManifest(cwd, codegenRoutes, graph.definitions))
      }
    }

    // 6. Check every module's db/schema.ts is re-exported from the root
    // db/schema.ts, for modules created or edited by hand.
    const schemaAggregationResults = await checkModuleSchemaAggregation(cwd, cache)
    checks.push(...schemaAggregationResults)

    // 6.5. Check each aggregate object lists every table its file declares, and
    // the root's every module table it does not spread, for a table added by hand
    // or by a release before the scaffolders wrote the key. Not changed-filtered,
    // for check 8's reason.
    checks.push(...(await checkSchemaAggregateKeys(cwd, cache)))

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
      checks.push(...(await checkRouteContracts({
        cwd,
        routesFile: routeGraphFile,
        definitions,
        introspect: routeIntrospect,
      })))

      // 7.8. Check the routes that declare `.agent()` metadata (RFC 0016): the
      // tool name is legal and unique, a non-read-only tool is covered by
      // authorization rather than merely authentication, and the schemas an
      // agent reads exist. Shares 7.7's gate; content-activated inside.
      checks.push(
        ...(await checkAgentRoutes({ cwd, routesFile: routeGraphFile, definitions, cache, introspect: routeIntrospect })),
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

    // 7.95. In-process agents (RFC 0029 §8): appTools() names against the derived
    // tools and the class's scopes, aiPlugin() registered, one audit trail.
    // Content-activated. Gated like 7.7; a failed graph load leaves the names
    // unverified rather than underived, while an absent routes file derives none.
    if (sourceChanged) {
      checks.push(
        ...(await checkAiAgents({
          cwd,
          cache,
          ...(graph?.error ? {} : { definitions: graph?.definitions ?? [] }),
        })),
      )
    }

    // 8. Check Postgres timestamp columns carry a time zone. Content-activated
    // and dialect-gated. Not changed-filtered: the schema is a handful of files,
    // so narrowing would hide a column an unrelated edit never touched.
    const schemaTimestampResults = checkSchemaTimestamps(schemaTables)
    checks.push(...schemaTimestampResults)

    // 8.5. Check configureAttachments() binds a table the schema declares (RFC
    // 0013); the layer takes it untyped, so a renamed export only fails on the
    // first attach. Not changed-filtered: the failure originates in db/schema.ts,
    // so filtering by the config file would hide the rename this exists for.
    const configFiles = (await appConfigFiles) ?? []
    const wiring = { introspect: wiringIntrospect, wiring: attachmentsWiring }
    checks.push(...(await checkAttachmentsConfig({ cwd, cache, files: configFiles, schemaTables, ...wiring })))

    // 8.6. The prior question: a model mixing in Attachable(...) in an app with
    // no configureAttachments() call at all. Same runtime-only failure as 8.5.
    checks.push(
      ...(await checkAttachableModels({ cwd, cache, files: allModelFiles, configFiles, ...wiring })),
    )

    // 8.6b. Session wiring (RFC 0020 §2): a `database` store bound to a table
    // the schema does not export, and a session config no provider binds. Over
    // the same config/src/app scan the attachments rules use. Not
    // changed-filtered: the config and its provider are different files.
    checks.push(
      ...(await checkSessionsConfig({ cwd, cache, files: configFiles, schemaTables, introspect: wiringIntrospect, wiring: sessionWiring })),
    )

    // 8.6c. Config wiring (RFC 0027 §6): a config/<key>.ts definition the entry's
    // createApp({ config }) array never lists binds nothing, and one it lists that
    // is not a definition fails the boot. Gated like 7.7 and 8.7: it imports the
    // definitions, so a run that changed no source must not execute them again.
    if (sourceChanged) {
      checks.push(...(await checkConfigWiring({ cwd, cache })))
    }

    // 8.65. The attachments disk rooted inside the statically served public/
    // tree, where uploaded bytes are reachable as static assets. Not
    // changed-filtered: the two halves of the finding live in different files
    // (the config names the disk, the storage provider roots it).
    checks.push(
      ...(await checkAttachmentsPublicDisk({ cwd, cache, files: configFiles, ...wiring })),
    )

    // 8.7. Delivery-route wiring (RFC 0015): a `delivery` config with no
    // registerAttachmentRoutes() route in the introspected app, and a
    // serve: 'redirect' disk whose driver can never presign. Both are invisible
    // at runtime by design (uniform 404s; a fail-closed downgrade to proxy).
    // Gated like 7.7, since the mount is a registered route.
    if (sourceChanged) {
      checks.push(
        ...(await checkAttachmentsDelivery({ cwd, cache, files: configFiles, ...wiring })),
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

  // Environment example (RFC 0027 §7): `.env.example` names the keys `config/env.ts`
  // declares. The schema is imported, so any source change can move it.
  if (runs('env') && (sourceChanged || changedFiles?.has(ENV_EXAMPLE_FILE))) {
    checks.push(...(await checkEnvExample(cwd)))
  }

  // 10.6. Prototype wiring (RFC 0021 §5): every `prototype` route has a fixture
  // entry, every entry names a route, and createApp() hands the fixture over.
  // Reads the same graph as 7.7; a load failure was reported there, or is
  // swallowed here when the suite runs alone (the graph check is core's).
  if (runs('prototype')) {
    if (!graph && !runs('core')) {
      graph = await loadRouteGraph(cwd, await routesEntryOrDefault(cwd, options.routesFile))
    }
    checks.push(...(await checkPrototypeRoutes({ cwd, cache, definitions: graph?.definitions, introspect: routeIntrospect })))
  }

  // Implementation plans (RFC 0030 §8), only when asked for: judging a plan imports
  // `db/schema.ts` and the validator files, which no other suite does.
  if (selected.has('plan') && (sourceChanged || [...(changedFiles ?? [])].some(isPlanInput))) {
    checks.push(...(await checkPlans({ cwd, routesFile: options.routesFile })))
  }

  // 11. Check architecture boundaries (guren.arch.ts + derived module rules)
  if (runs('arch')) {
    const archResults = await runArchCheck({ cwd, cache, changedFiles })
    checks.push(...archResults)
  }

  // 12. Deploy runtime (RFC 0020 Part 0): doctor's three verdicts, for an app
  // declaring a deploy plugin or the Lambda adapter; every other app adds nothing.
  // Advisory: the manifest is read with this environment's `.env`, and the facts it does not
  // carry are read from constructions, not intent, so a false positive must not fail a gate.
  for (const verdict of (await deployRuntime) ?? []) {
    checks.push({
      ...check(verdict.key, verdict.title, verdict.status, verdict.message, verdict.fix),
      advisory: true,
      evidence: verdict.evidence,
      ...(verdict.evidenceReason ? { evidenceReason: verdict.evidenceReason } : {}),
    })
  }

  const unavailable = await introspectionUnavailable(introspection)
  if (unavailable) checks.push(unavailable)

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

  for (const run of report.fixes ?? []) {
    if (run.ok) {
      consola.success(`[fixed] ${run.command}`)
      continue
    }
    consola.error(`[fix failed] ${run.command}`)
    for (const line of run.output ?? []) consola.info(`       ${line}`)
  }

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
  const fixable = report.checks.filter((result) => result.status !== 'pass' && result.fix).length
  if (report.fixes === undefined && fixable > 0) {
    console.log(`${fixable === 1 ? 'One finding clears' : `${fixable} findings clear`} by regenerating files: run this check again with --fix.`)
  }
}
