/**
 * The Guren CLI's builtin command registry, importable without running the CLI —
 * the agent-catalog audit reads it to assert a skill only names commands and
 * flags the CLI actually registers (RFC 0011 §2). `bin.ts` imports this and adds
 * the per-invocation, cwd-dependent parts.
 *
 * Nothing here runs at import beyond building the command objects. Keep it that
 * way: a top-level `await` or `process.*` read would run for every importer.
 */
import { consola } from 'consola'
import { showUsage } from 'citty'
import {
  makeCommands,
  makeAdrCommand,
  makeValidatorCommand,
  makeTestCommand,
  makeAuthCommand,
  makeModuleCommand,
  makeAgentCommand,
  makeAiAgentCommand,
  makeListenerCommand,
  makeResourceCommand,
  makeFactoryCommand,
  makeConsoleCommandCommand,
  makeChannelCommand,
  makeExceptionCommand,
  makeMigrationCommand,
  makeLangCommand,
  makeFeatureCommand,
} from './commands/make'
import { ATTACH_ARG, FIELDS_ARG } from './commands/scaffold-options'
import { routeTypesCommand, codegenCommand, openApiGenerateCommand } from './commands/codegen'
import { migrateCommand, seedCommand, resetCommand, freshCommand, rollbackCommand, statusCommand } from './commands/database'
import { introspectCommand } from './commands/introspect'
import { planCommand, planRenderCommand, planStatusCommand, planVerifyCommand, planNextCommand, planScaffoldCommand, planApproveCommand, planWaiveCommand, planReviseCommand, planCloseCommand } from './commands/plan'
import { toolListCommand, toolInspectCommand, toolCallCommand, toolLogCommand, tokenIssueCommand, toolDevCommand } from './commands/tools'
import { assertDestructiveCommandAllowed } from './commands/destructive-guard'
import { checkCommand, auditCommand, gateCommand } from './commands/diagnostics'
import { defineCommand, keepsProcessAlive } from './define-command'
import { UsageError } from './run-cli'
import { newCommand } from './new-command'
import { addResource, runBlueprint } from './blueprints'
import { runDoctor } from './doctor'
import { CODEGEN_STEP } from './make-auth'
import { parseNumericArg, runAiEval } from './ai-eval'
import { isRepoSlug } from './issue-refs'
import { writeSpecArtifacts } from './spec-generate'
import { buildDocsGraphReport, renderDocsGraphMarkdown } from './docs-graph'
import { announceKeptFiles, announceWrittenFiles } from './utils'
import { consoleCommand } from './console'
import { loadApplication } from './runtime'
import { runQueueWorker, listFailedJobs, retryFailedJob, retryAllFailedJobs, flushFailedJobs } from './queue'
import { displayRoutes } from './route-list'
import { cacheConfig, clearConfigCache, showConfigCacheInfo } from './config-cache'
import { createStorageLink, removeStorageLink } from './storage-link'
import { listScheduledTasks, runScheduledTasks } from './schedule'
import { runHealthCheck } from './health-check'
import { publishLanguageFiles, listLocales } from './lang'
import { upgradeCanary, DEFAULT_UPGRADE_TAG } from './upgrade'
import { scaffoldDeploy, type DeployTarget } from './deploy'
import { installPlugin } from './plugin'
import { displayModels } from './model-list'
import { displayContext } from './context'
import { displayEntityContext } from './entity-context'
import { ENV_EXAMPLE_FILE, ENV_SCHEMA_FILE, loadEnvSchema, writeEnvExample } from './app-env'
import { generateGuidelines } from './guidelines'
import { installAgentHarness, type AgentHarnessResult } from './agent-harness'
import { AGENT_TARGETS, parseTargetList, type AgentTarget } from './agent-targets'
import { generateKeyValue, writeKeyToEnv } from './key-generate'

const specGenerateCommand = defineCommand({
  meta: {
    name: 'spec:generate',
    description: 'Generate spec views (ER, domain model, screens, modules) into docs/spec.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    await writeSpecArtifacts({ cwd: args.app, routesFile: args.routes })
  },
})

const docsGraphCommand = defineCommand({
  meta: {
    name: 'docs:graph',
    description:
      'Show the OKF docs relation graph: documents, entities, code paths, and verified edges. Narrow with --entity or --path to answer "what governs this?" before renaming or editing.',
  },
  args: {
    entity: {
      type: 'string',
      description: 'Narrow to the neighborhood of one model entity (case-insensitive).',
    },
    path: {
      type: 'string',
      description: 'Narrow to the neighborhood of one app-root-relative path.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
  },
  async run({ args }) {
    const report = await buildDocsGraphReport({
      cwd: args.app,
      entity: args.entity,
      path: args.path,
    })
    console.log(args.json ? JSON.stringify(report, null, 2) : renderDocsGraphMarkdown(report))
  },
})

const aiEvalCommand = defineCommand({
  meta: {
    name: 'ai:eval',
    description:
      'Run one eval against the real model (RFC 0029). Opt-in and never part of check or gate: every case calls the model.',
  },
  args: {
    flow: {
      type: 'positional',
      required: true,
      description: 'Eval name, resolved to tests/evals/<flow>.eval.ts',
    },
    variant: {
      type: 'string',
      description: 'Result directory under the flow (default: baseline)',
    },
    reps: {
      type: 'string',
      description: 'Run each case this many times',
    },
    cases: {
      type: 'string',
      description: 'Run only the first N cases, in file order',
    },
    'max-cost-usd': {
      type: 'string',
      description: 'Soft ceiling: no new case starts once the derived cost crosses it',
    },
    concurrency: {
      type: 'string',
      description: 'Cases in flight at once (default: 1)',
    },
    'dry-run': {
      type: 'boolean',
      alias: 'd',
      description: 'Resolve the cases and report what would run, calling no model and writing nothing',
    },
    file: {
      type: 'string',
      description: 'Path to the eval file, instead of resolving it from the flow name',
    },
    dir: {
      type: 'string',
      description: 'Directory the flow name resolves in (default: tests/evals)',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Print the summary as JSON',
    },
  },
  async run({ args }) {
    const result = await runAiEval({
      flow: String(args.flow),
      variant: args.variant ? String(args.variant) : undefined,
      reps: parseNumericArg('reps', args.reps),
      cases: parseNumericArg('cases', args.cases),
      maxCostUsd: parseNumericArg('max-cost-usd', args['max-cost-usd']),
      concurrency: parseNumericArg('concurrency', args.concurrency),
      dryRun: Boolean(args['dry-run']),
      file: args.file ? String(args.file) : undefined,
      dir: args.dir ? String(args.dir) : undefined,
      appRoot: args.app ? String(args.app) : undefined,
      json: Boolean(args.json),
    })
    // A case that produced nothing scorable is a run the caller must see fail.
    if (result.failures.length > 0) process.exitCode = 1
  },
})

const queueWorkCommand = defineCommand({
  meta: {
    name: 'queue:work',
    description: 'Start a queue worker to process jobs.',
  },
  args: {
    queue: {
      type: 'string',
      description: 'Queue names to process (comma-separated)',
      default: 'default',
    },
    once: {
      type: 'boolean',
      description: 'Process only one job and exit',
    },
    'stop-when-empty': {
      type: 'boolean',
      description: 'Exit once the queues are empty instead of polling for new jobs',
    },
    sleep: {
      type: 'string',
      description: 'Sleep time between polls (ms)',
      default: '1000',
    },
    timeout: {
      type: 'string',
      description: 'Job timeout in seconds',
      default: '60',
    },
    'max-jobs': {
      type: 'string',
      description: 'Maximum jobs to process (0 = unlimited)',
      default: '0',
    },
  },
  async run({ args }) {
    await runQueueWorker({
      queue: args.queue,
      once: args.once,
      stopWhenEmpty: args['stop-when-empty'],
      sleep: parseInt(args.sleep ?? '1000', 10),
      timeout: parseInt(args.timeout ?? '60', 10),
      maxJobs: parseInt(args['max-jobs'] ?? '0', 10),
    })
  },
})

const queueFailedCommand = defineCommand({
  meta: {
    name: 'queue:failed',
    description: 'List all failed queue jobs.',
  },
  args: {
    queue: {
      type: 'string',
      description: 'Filter by queue name',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await listFailedJobs(args.queue, { json: Boolean(args.json) })
  },
})

const queueRetryCommand = defineCommand({
  meta: {
    name: 'queue:retry',
    description: 'Retry a failed job or all failed jobs.',
  },
  args: {
    // Left `positional`, unlike `context`'s entity arg: citty drops `--id 42`
    // entirely, but here that lands in the `else` below, which reports the
    // missing id and exits 1 — loud enough already.
    id: {
      type: 'positional',
      required: false,
      description: 'Job ID to retry (or --all for all jobs)',
    },
    all: {
      type: 'boolean',
      description: 'Retry all failed jobs',
    },
    queue: {
      type: 'string',
      description: 'Filter by queue name (with --all)',
    },
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
  },
  async run({ args }) {
    assertDestructiveCommandAllowed(args.force)

    if (args.all) {
      await retryAllFailedJobs(args.queue)
    } else if (args.id) {
      await retryFailedJob(args.id)
    } else {
      consola.error('Please provide a job ID or use --all to retry all failed jobs.')
      process.exit(1)
    }
  },
})

const queueFlushCommand = defineCommand({
  meta: {
    name: 'queue:flush',
    description: 'Delete all failed jobs.',
  },
  args: {
    queue: {
      type: 'string',
      description: 'Filter by queue name',
    },
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    'dry-run': {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
  },
  async run({ args }) {
    assertDestructiveCommandAllowed(args.force)

    if (args['dry-run']) {
      const queueFilter = args.queue ? ` on queue "${args.queue}"` : ''
      consola.info(`[dry-run] Would delete all failed jobs${queueFilter}.`)
      return
    }

    await flushFailedJobs(args.queue)
  },
})

const routeListCommand = defineCommand({
  meta: {
    name: 'route:list',
    description: 'List all registered application routes.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    method: {
      type: 'string',
      description: 'Filter by HTTP method (GET, POST, etc.)',
      alias: 'm',
    },
    path: {
      type: 'string',
      description: 'Filter by path pattern',
      alias: 'p',
    },
    name: {
      type: 'string',
      description: 'Filter by route name',
      alias: 'n',
    },
    format: {
      type: 'string',
      description: 'Output format (table, json, compact)',
      default: 'table',
    },
    sort: {
      type: 'string',
      description: 'Sort by (method, path, name)',
      alias: 's',
    },
    reverse: {
      type: 'boolean',
      description: 'Reverse sort order',
      alias: 'r',
    },
  },
  async run({ args }) {
    await displayRoutes({
      routesFile: args.routes,
      appRoot: args.app,
      method: args.method,
      path: args.path,
      name: args.name,
      format: args.format as 'table' | 'json' | 'compact',
      sort: args.sort as 'method' | 'path' | 'name',
      reverse: args.reverse,
    })
  },
})

// The `tool:` namespace is RFC 0016's; `agent:` is the coding-agent harness's.
// Both commands derive live from the route graph rather than reading
// `.guren/agents.gen.ts`, so a stale manifest cannot answer for what an agent
// would actually see.
const configCacheCommand = defineCommand({
  meta: {
    name: 'config:cache',
    description: 'Create a cache file for faster configuration loading.',
  },
  args: {
    config: {
      type: 'string',
      description: 'Config directory path',
      valueHint: 'config',
    },
    cache: {
      type: 'string',
      description: 'Cache output directory',
      valueHint: 'bootstrap/cache',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    await cacheConfig({
      configDir: args.config,
      cacheDir: args.cache,
      appRoot: args.app,
    })
  },
})

const configClearCommand = defineCommand({
  meta: {
    name: 'config:clear',
    description: 'Remove the configuration cache file.',
  },
  args: {
    cache: {
      type: 'string',
      description: 'Cache directory path',
      valueHint: 'bootstrap/cache',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
  },
  async run({ args }) {
    clearConfigCache({
      cacheDir: args.cache,
      appRoot: args.app,
    })
  },
})

const configShowCommand = defineCommand({
  meta: {
    name: 'config:show',
    description: 'Show configuration cache info.',
  },
  args: {
    cache: {
      type: 'string',
      description: 'Cache directory path',
      valueHint: 'bootstrap/cache',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    showConfigCacheInfo({
      cacheDir: args.cache,
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

const storageLinkCommand = defineCommand({
  meta: {
    name: 'storage:link',
    description: 'Create a symbolic link from public/storage to storage/app/public.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite existing link',
      alias: 'f',
    },
    relative: {
      type: 'boolean',
      description: 'Use relative path for symbolic link',
      alias: 'r',
    },
    remove: {
      type: 'boolean',
      description: 'Remove the symbolic link instead of creating it',
    },
  },
  async run({ args }) {
    if (args.remove) {
      const success = removeStorageLink()
      if (!success) {
        process.exit(1)
      }
    } else {
      const success = createStorageLink({
        force: Boolean(args.force),
        relative: Boolean(args.relative),
      })
      if (!success) {
        process.exit(1)
      }
    }
  },
})

const scheduleListCommand = defineCommand({
  meta: {
    name: 'schedule:list',
    description: 'List all registered scheduled tasks.',
  },
  args: {
    kernel: {
      type: 'string',
      description: 'Path to the schedule kernel file',
      valueHint: 'app/Console/Kernel.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await listScheduledTasks({
      kernel: args.kernel,
      appRoot: args.app,
      json: Boolean(args.json),
    })
  },
})

const scheduleRunCommand = defineCommand({
  meta: {
    name: 'schedule:run',
    description: 'Run scheduled tasks that are due.',
  },
  args: {
    kernel: {
      type: 'string',
      description: 'Path to the schedule kernel file',
      valueHint: 'app/Console/Kernel.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    task: {
      type: 'string',
      description: 'Run a specific task by name',
      alias: 't',
    },
    force: {
      type: 'boolean',
      description: 'Run tasks regardless of schedule',
      alias: 'f',
    },
  },
  async run({ args }) {
    await runScheduledTasks({
      kernel: args.kernel,
      appRoot: args.app,
      task: args.task,
      force: args.force,
    })
  },
})

const healthCheckCommand = defineCommand({
  meta: {
    name: 'health:check',
    description: 'Run application health checks.',
  },
  args: {
    health: {
      type: 'string',
      description: 'Path to the health configuration file',
      valueHint: 'app/health.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    checks: {
      type: 'string',
      description: 'Run specific checks only (comma-separated)',
      alias: 'c',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await runHealthCheck({
      health: args.health,
      appRoot: args.app,
      checks: args.checks,
      json: args.json,
    })
  },
})

const langPublishCommand = defineCommand({
  meta: {
    name: 'lang:publish',
    description: 'Publish default language file templates.',
  },
  args: {
    path: {
      type: 'string',
      description: 'Path to the language files directory',
      valueHint: 'lang',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const files = publishLanguageFiles({
      path: args.path,
      appRoot: args.app,
      force: args.force,
    })

    if (files.length === 0) {
      consola.info('No files were created.')
    } else {
      consola.info('')
      consola.success(`Published ${files.length} language file(s).`)
    }
  },
})

const envExampleCommand = defineCommand({
  meta: {
    name: 'env:example',
    description: 'Append the keys config/env.ts declares to .env.example (RFC 0027). Lines already there are kept.',
  },
  args: {
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    const cwd = args.app ?? process.cwd()
    const schema = await loadEnvSchema(cwd)
    if (schema.status !== 'loaded') {
      consola.error(schema.status === 'absent' ? `No ${ENV_SCHEMA_FILE}: declare the environment with defineEnv() first.` : schema.message)
      process.exitCode = 1
      return
    }

    const { added, undeclared } = await writeEnvExample(cwd, schema.vars)
    if (added.length > 0) {
      consola.success(`Added ${added.join(', ')} to ${ENV_EXAMPLE_FILE}.`)
    } else {
      consola.info(`${ENV_EXAMPLE_FILE} already lists every key ${ENV_SCHEMA_FILE} declares.`)
    }
    if (undeclared.length > 0) {
      consola.warn(`${ENV_EXAMPLE_FILE} also sets ${undeclared.join(', ')}, which ${ENV_SCHEMA_FILE} does not declare. Left in place.`)
    }
  },
})

const langListCommand = defineCommand({
  meta: {
    name: 'lang:list',
    description: 'List available language locales.',
  },
  args: {
    path: {
      type: 'string',
      description: 'Path to the language files directory',
      valueHint: 'lang',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    const locales = listLocales({
      path: args.path,
      appRoot: args.app,
    })

    if (args.json) {
      consola.log(JSON.stringify(locales, null, 2))
      return
    }

    if (locales.length === 0) {
      consola.info('No language locales found.')
      consola.info('Run `bunx guren lang:publish` to create default language files.')
    } else {
      console.log('')
      console.log('Available Locales')
      console.log('=================')
      console.log('')
      for (const locale of locales) {
        console.log(`  - ${locale}`)
      }
      console.log('')
      console.log(`Total: ${locales.length} locale(s)`)
    }
  },
})

const devCommand = keepsProcessAlive(defineCommand({
  meta: {
    name: 'dev',
    description: 'Start the Guren application in development mode using Bun.',
  },
  async run() {
    const { app } = await loadApplication()

    // `PORT=0` means "any free port", so this tests for a number, not truthiness.
    const parsedPort = Number.parseInt(process.env.PORT ?? '', 10)
    const port = Number.isInteger(parsedPort) ? parsedPort : 3333
    const hostname = process.env.HOST || '0.0.0.0'

    let address: { url?: string } | undefined
    try {
      address = (await app.listen?.({ port, hostname })) as { url?: string } | undefined
    } catch (error) {
      throw new Error(`Failed to start application listener: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }

    // Report where it actually bound: the requested port is not it once the walk
    // moves past a busy one, or when PORT=0 lets the OS choose. The fallback is
    // for a `@guren/server` older than the bound-address return.
    consola.success(
      `Development server listening on ${address?.url ?? `http://${hostname}:${port}`}`,
    )
  },
}))

const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Inspect the current workspace for vNext runtime, codegen, and bootstrap issues.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output the doctor report as JSON.',
    },
    strict: {
      type: 'boolean',
      description: 'Exit with code 1 when warnings or failures are reported.',
    },
    next: {
      type: 'boolean',
      description: 'Show actionable next steps for the project.',
    },
    // Positive on purpose, so citty's negation lands on this key; `default: true` prints `--no-introspect`.
    introspect: {
      type: 'boolean',
      default: true,
      description: 'Judge from source only, without introspecting the app (RFC 0026).',
    },
  },
  async run({ args }) {
    const report = await runDoctor({
      json: Boolean(args.json),
      next: Boolean(args.next),
      introspect: args.introspect !== false,
    })

    if (args.json) {
      consola.log(JSON.stringify(report, null, 2))
    }

    if (args.strict && (report.hasWarnings || report.hasFailures)) {
      process.exit(1)
    }
  },
})

const keyGenerateCommand = defineCommand({
  meta: {
    name: 'key:generate',
    description: 'Generate a canonical APP_KEY value.',
  },
  args: {
    write: {
      type: 'boolean',
      description: 'Write the generated APP_KEY to .env in the current workspace.',
    },
  },
  async run({ args }) {
    const key = generateKeyValue()

    if (args.write) {
      await writeKeyToEnv(process.cwd(), key)
      consola.success('APP_KEY written to .env')
      return
    }

    consola.log(key)
  },
})

const modelListCommand = defineCommand({
  meta: {
    name: 'model:list',
    description: 'List all models with relationships and metadata.',
  },
  args: {
    format: {
      type: 'string',
      description: 'Output format: table, json, or compact.',
      default: 'table',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    await displayModels({
      appRoot: args.app,
      format: args.format as 'table' | 'json' | 'compact',
    })
  },
})

const contextCommand = defineCommand({
  meta: {
    name: 'context',
    description: 'Generate a project context map for AI agents. Pass an entity name (e.g. `guren context User`) for an entity-centric bundle.',
  },
  args: {
    // Declared `string`, not `positional`, so both spellings reach the entity
    // path: citty drops a value passed as a flag to a positional and raises no
    // unknown-flag error, so `guren context --entity User` would print the
    // whole-project map and exit 0. A `string` arg still leaves the bare
    // positional in `_`.
    entity: {
      type: 'string',
      valueHint: 'User',
      description:
        'Model class name for an entity-centric context bundle (case-insensitive). Also accepted positionally: `guren context User`.',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON.',
    },
    routes: {
      type: 'string',
      description: 'Path to routes entry file.',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
    module: {
      type: 'string',
      description: 'Module name to disambiguate same-named models; "app" selects the application root (entity mode only).',
    },
    live: {
      type: 'boolean',
      description:
        'Ask gh for the state, assignees and labels of each linked issue (entity mode only). Off by default; the bundle never needs the network.',
    },
    repo: {
      type: 'string',
      valueHint: 'owner/name',
      description: 'Repository bare issue numbers belong to, instead of the origin remote (entity mode only).',
    },
    // Same shape as check's `introspect` flag in commands/diagnostics.ts.
    introspect: {
      type: 'boolean',
      default: true,
      description: 'List routes from the routes file only, without introspecting the app (RFC 0026).',
    },
  },
  async run({ args }) {
    const cwd = args.app
    const routesFile = args.routes
    const json = Boolean(args.json)
    const entity = args.entity ?? args._[0]
    if (args.repo !== undefined && !isRepoSlug(args.repo)) {
      throw new UsageError(`--repo must be owner/name, got "${args.repo}".`)
    }

    if (entity) {
      await displayEntityContext(entity, {
        cwd,
        json,
        routesFile,
        module: args.module,
        live: args.live,
        repo: args.repo,
        introspect: args.introspect !== false,
      })
      return
    }

    await displayContext({
      cwd,
      json,
      routesFile,
      introspect: args.introspect !== false,
    })
  },
})

const guidelinesCommand = defineCommand({
  meta: {
    name: 'guidelines',
    description: 'Auto-generate project-specific coding guidelines.',
  },
  args: {
    output: {
      type: 'string',
      alias: 'o',
      description: 'Write guidelines to file path (e.g., .claude/rules/project-guidelines.md).',
    },
    app: {
      type: 'string',
      description: 'Application root directory.',
    },
  },
  async run({ args }) {
    const output = await generateGuidelines({
      cwd: args.app,
      output: args.output,
    })

    if (!args.output) {
      console.log(output)
    }
  },
})

function reportAgentHarnessResult(result: AgentHarnessResult): void {
  const wroteVerb = result.dryRun ? 'Would write' : 'Wrote'
  const replacedVerb = result.dryRun ? 'would replace' : 'replaced'

  for (const file of result.written) {
    consola.success(`${wroteVerb} ${file}`)
  }
  if (result.replaced.length > 0) {
    // The one destructive step, so it gets the one warning. The sync-specific
    // advice is exactly wrong for init --force, which replaces files the user
    // owns — CLAUDE.md *is* the user's own file.
    const advice =
      result.mode === 'sync'
        ? 'Local edits to framework-managed files do not survive agent:sync. Keep project-specific rules in files of your own — sync never touches files it does not ship.'
        : 'These files were replaced because --force was passed; the previous contents are gone.'
    consola.warn(
      `${result.replaced.length} of those ${replacedVerb} existing contents: ${result.replaced.join(', ')}\n${advice}`,
    )
  }
  if (result.unchanged.length > 0) {
    consola.info(`${result.unchanged.length} file(s) already up to date.`)
  }
  if (result.skipped.length > 0) {
    consola.info(`Skipped ${result.skipped.length} existing file(s): ${result.skipped.join(', ')}`)
  }
  if (result.stale.length > 0) {
    if (result.pruned) {
      consola.success(`Removed ${result.stale.length} stale managed file(s): ${result.stale.join(', ')}`)
    } else if (result.pruneRequested && result.dryRun) {
      consola.info(
        `Would remove ${result.stale.length} stale managed file(s): ${result.stale.join(', ')}`,
      )
    } else {
      consola.info(
        `Found ${result.stale.length} file(s) in framework-managed directories that are not part of the current harness: ${result.stale.join(', ')}\n` +
          'If they are leftovers from an earlier harness version, remove them with `bunx guren agent:sync --prune`. Files you authored yourself are safe to keep — sync never deletes without --prune.',
      )
    }
  }
  for (const hint of result.mergeHints) {
    consola.info(
      `${hint.path} already exists, so it was left alone. Add ${hint.what} to it yourself:\n${hint.snippet}`,
    )
  }
  for (const path of new Set(result.legacyHookCommands.map((entry) => entry.path))) {
    // Every sync, unlike the init-only merge hints: these hooks fail, they are not merely absent.
    // JSON-quoted, so each side pastes into the file as a whole, escaped value.
    const edits = result.legacyHookCommands
      .filter((entry) => entry.path === path)
      .map((entry) => `  ${JSON.stringify(entry.from)}\n  -> ${JSON.stringify(entry.to)}`)
    consola.warn(
      `${path} runs Guren hooks from the session cwd, ` +
        'which breaks once the agent changes into a subdirectory. The file is yours, so it was left alone; ' +
        `replace each "command" value:\n${edits.join('\n')}`,
    )
  }
  if (result.mcpEndpointNotEnabled) {
    consola.info(
      'The agent MCP config points at the dev server MCP endpoint, which is opt-in. ' +
      'Add `GUREN_MCP=1` to your `dev` script, or start the server with `GUREN_MCP=1 bun run dev`.',
    )
  }
}

const AGENT_TARGETS_HELP = `Comma-separated agent targets: ${AGENT_TARGETS.join(', ')}, or "all".`

function parseTargetArg(raw: string): AgentTarget[] {
  try {
    return parseTargetList(raw)
  } catch (error) {
    // a typo is a usage problem: usage + message, not a stack trace
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

const AGENT_INIT_ARGS = {
  force: {
    type: 'boolean',
    alias: 'f',
    description: 'Overwrite existing files, including CLAUDE.md, AGENTS.md, and .claude/settings.json.',
  },
  target: {
    type: 'string',
    description: `${AGENT_TARGETS_HELP} Default: claude.`,
  },
  'dry-run': {
    type: 'boolean',
    description:
      'Report what the init would write or replace without changing any file — the preview for --force.',
  },
  app: {
    type: 'string',
    description: 'Application root directory.',
  },
} as const

const agentInitCommand = defineCommand({
  meta: {
    name: 'agent:init',
    description:
      'Install the AI agent harness (CLAUDE.md/AGENTS.md, rules, skills, hooks, MCP config) for the selected agents.',
  },
  args: AGENT_INIT_ARGS,
  async run({ args }) {
    const result = await installAgentHarness({
      cwd: args.app,
      mode: 'init',
      force: Boolean(args.force),
      targets: args.target ? parseTargetArg(args.target) : undefined,
      dryRun: Boolean(args['dry-run']),
    })
    reportAgentHarnessResult(result)
    consola.success(
      result.dryRun
        ? agentDryRunClosingLine('agent:init', AGENT_INIT_ARGS, args)
        : 'AI agent harness is ready. Update it later with `bunx guren agent:sync`.',
    )
  },
})

/**
 * The dry run's closing line, whose "run this to apply" hint carries the run's
 * own flags — the applied command must be the previewed one. Derived from the
 * declared arg spec so a future flag cannot fall out of the hint, and spelled
 * verbatim: a declared name is the spelling citty registers, so rewriting its
 * case here would print a flag the CLI does not parse.
 */
function agentDryRunClosingLine(
  commandName: 'agent:init' | 'agent:sync',
  argsSpec: Record<string, { type?: string }>,
  args: Record<string, unknown>,
): string {
  let suffix = ''
  for (const name of Object.keys(argsSpec)) {
    if (name === 'dry-run') continue
    const flag = `--${name}`
    const value = args[name]
    if (argsSpec[name]?.type === 'boolean') {
      if (value) suffix += ` ${flag}`
    } else if (typeof value === 'string' && value !== '') {
      suffix += ` ${flag} ${value}`
    }
  }
  return `[dry-run] Nothing was written. Run \`bunx guren ${commandName}${suffix}\` to apply.`
}

const AGENT_SYNC_ARGS = {
  target: {
    type: 'string',
    description: `${AGENT_TARGETS_HELP} Default: every target detected on disk.`,
  },
  prune: {
    type: 'boolean',
    description:
      'Delete files in framework-managed directories that are no longer part of the harness. Without this flag they are only reported.',
  },
  'dry-run': {
    type: 'boolean',
    description: 'Report what the sync would write, replace, or prune without changing any file.',
  },
  app: {
    type: 'string',
    description: 'Application root directory.',
  },
} as const

const agentSyncCommand = defineCommand({
  meta: {
    name: 'agent:sync',
    description:
      'Update framework-managed agent harness files (rules, skills, agents, hooks) for every installed agent.',
  },
  args: AGENT_SYNC_ARGS,
  async run({ args }) {
    const result = await installAgentHarness({
      cwd: args.app,
      mode: 'sync',
      targets: args.target ? parseTargetArg(args.target) : undefined,
      prune: Boolean(args.prune),
      dryRun: Boolean(args['dry-run']),
    })
    reportAgentHarnessResult(result)
    consola.success(
      result.dryRun
        ? agentDryRunClosingLine('agent:sync', AGENT_SYNC_ARGS, args)
        : 'Agent harness synced to the latest framework version.',
    )
  },
})

const addAuthCommand = defineCommand({
  meta: {
    name: 'auth',
    description: 'Add authentication scaffolding to the current application.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const overwritten: string[] = []
    const files = await runBlueprint('auth', {
      force: Boolean(args.force),
      overwritten,
    })

    announceWrittenFiles(files, overwritten)
  },
})

const addAdminCommand = defineCommand({
  meta: {
    name: 'admin',
    description: 'Install a starter admin dashboard scaffold with routes and page.',
  },
  args: {
    public: {
      type: 'boolean',
      description: 'Skip the authentication check on the dashboard route (default: auth required)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const overwritten: string[] = []
    const createdFiles = await runBlueprint('admin', {
      publicAccess: Boolean(args.public),
      force: Boolean(args.force),
      overwritten,
    })

    announceWrittenFiles(createdFiles, overwritten)

    if (!args.public) {
      // Describes routes/admin.ts, not runtime behaviour — the wiring step
      // above may have reported it could not reach a registrar.
      consola.info(
        `  routes/admin.ts guards /admin and redirects to /login — that sign-in page comes from \`bunx guren add auth\`. Pass --public to opt out.`,
      )
    }
  },
})

const addResourceCommand = defineCommand({
  meta: {
    name: 'resource',
    description: 'Scaffold a model, controller, view, and route group for a resource.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Resource name (singular)',
    },
    fields: FIELDS_ARG,
    attach: ATTACH_ARG,
    public: {
      type: 'boolean',
      description: 'Skip authentication checks in store/update/destroy actions',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const overwritten: string[] = []
    const { created, kept, schemaUpdated, routesUpdated } = await addResource({
      name: String(args.name),
      fields: typeof args.fields === 'string' ? args.fields : undefined,
      attach: typeof args.attach === 'string' ? args.attach : undefined,
      publicAccess: Boolean(args.public),
      force: Boolean(args.force),
      overwritten,
    })

    announceWrittenFiles(created, overwritten)
    announceKeptFiles(kept)

    consola.info('')
    consola.info(schemaUpdated
      ? 'Added the table to db/schema.ts.'
      : 'db/schema.ts already declares this table: left unchanged, so there is no migration to generate.')
    consola.info(routesUpdated
      ? 'Registered the route group in routes/web.ts.'
      : 'routes/web.ts already registers these routes: left unchanged.')
    consola.info('Next steps:')
    if (schemaUpdated) {
      consola.info('  • Run `bun run db:make` to generate the migration')
      consola.info('  • Run `bun run db:migrate` to apply it')
    }
    consola.info(CODEGEN_STEP)
    if (!args.public) {
      consola.info('  • store/update/destroy require a signed-in user — pass --public to opt out')
    }
  },
})

function createAddBlueprintCommand(
  blueprint: string,
  description: string,
  needsName = false,
) {
  return defineCommand({
    meta: {
      name: blueprint,
      description,
    },
    args: {
      ...(needsName
        ? {
            name: {
              type: 'positional' as const,
              required: true,
              description: 'Blueprint argument',
            },
          }
        : {}),
      force: {
        type: 'boolean' as const,
        description: 'Overwrite existing files',
        alias: 'f',
      },
    },
    async run({ args }) {
      const overwritten: string[] = []
      const createdFiles = await runBlueprint(blueprint, {
        name: typeof args.name === 'string' ? args.name : undefined,
        force: Boolean(args.force),
        overwritten,
      })

      announceWrittenFiles(createdFiles, overwritten)
    },
  })
}

const addPluginCommand = defineCommand({
  meta: {
    name: 'plugin',
    description: 'Install a plugin package and register its provider in src/app.ts.',
  },
  args: {
    package: {
      type: 'positional',
      required: true,
      description: 'Plugin package name (for example: @acme/guren-plugin-foo)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing plugin registration and published files',
      alias: 'f',
    },
    install: {
      type: 'boolean',
      default: true,
      description: 'Install the package with bun add when missing (--no-install to skip)',
    },
    'ignore-compatibility': {
      type: 'boolean',
      description: 'Register the plugin even when it declares an incompatible Guren version range',
    },
  },
  async run({ args }) {
    const result = await installPlugin({
      packageName: String(args.package),
      force: Boolean(args.force),
      install: args.install !== false,
      ignoreCompatibility: Boolean(args['ignore-compatibility']),
    })

    for (const message of result) {
      switch (message.kind) {
        case 'installed':
          consola.success(`Installed ${message.text}`)
          break
        case 'updated':
          consola.success(`Updated ${message.text}`)
          break
        case 'checked':
          consola.info(`Checked ${message.text}`)
          break
        case 'skipped':
          consola.info(`Skipped ${message.text}`)
          break
        case 'warning':
          consola.warn(message.text)
          break
        case 'hint':
          consola.info(message.text)
          break
      }
    }
  },
})

const addAiCommand = defineCommand({
  meta: {
    name: 'ai',
    description: 'Install in-process AI agents (RFC 0029): config/ai.ts, the provider key, aiPlugin(), and the packages.',
  },
  args: {
    provider: {
      type: 'string',
      description: 'Model provider for config/ai.ts: anthropic, openai, or gateway (default: anthropic).',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite config/ai.ts if it exists.',
    },
    install: {
      type: 'boolean',
      default: true,
      description: 'Run bun add for missing packages (--no-install prints the command instead).',
    },
    conversations: {
      type: 'boolean',
      default: true,
      description: 'Add the ai_conversations and ai_messages tables and store conversations in them (--no-conversations skips both).',
    },
  },
  async run({ args }) {
    const { addAi } = await import('./add-ai')
    const overwritten: string[] = []
    const created = await addAi({
      provider: args.provider,
      force: Boolean(args.force),
      install: args.install,
      conversations: args.conversations,
      overwritten,
    })
    announceWrittenFiles(created, overwritten)
    consola.info('Next: bunx guren make:ai-agent <Name> --tools <tool,...> --test')
  },
})

const addPrototypeCommand = defineCommand({
  meta: {
    name: 'prototype',
    description: 'Install prototype mode (RFC 0021): the fixture module, the dev:prototype/build:prototype scripts, and the client and app wiring.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Overwrite the fixture module if it exists.',
    },
    remove: {
      type: 'boolean',
      description: 'Reverse the wiring and the scripts; the fixture module is left in place.',
    },
  },
  async run({ args }) {
    const { addPrototype } = await import('./add-prototype')
    await addPrototype({ force: Boolean(args.force), remove: Boolean(args.remove) })
  },
})

const addSubCommands = {
  admin: addAdminCommand,
  ai: addAiCommand,
  attachments: createAddBlueprintCommand('attachments', 'Install the attachments layer: schema table, config, provider, and the prune command.'),
  auth: addAuthCommand,
  oauth: createAddBlueprintCommand('oauth', 'Install OAuth scaffolding with provider presets and callback routes.'),
  broadcasting: createAddBlueprintCommand('broadcasting', 'Install broadcasting scaffolding with sample public and private channels.'),
  cache: createAddBlueprintCommand('cache', 'Install cache scaffolding and an example cache service.'),
  events: createAddBlueprintCommand('events', 'Install event scaffolding with a sample event and listener.'),
  lint: createAddBlueprintCommand('lint', 'Install oxlint with the Guren rules: .oxlintrc.json, lint scripts, and the oxlint dev dependency.'),
  mail: createAddBlueprintCommand('mail', 'Install mail scaffolding with a sample mailable.'),
  notifications: createAddBlueprintCommand('notifications', 'Install notification scaffolding with sample channels and a sample notification.'),
  queue: createAddBlueprintCommand('queue', 'Install queue scaffolding with a sample job.'),
  resource: addResourceCommand,
  plugin: addPluginCommand,
  prototype: addPrototypeCommand,
  session: createAddBlueprintCommand('session', 'Install database-backed sessions: the schema table and migration, config/session.ts, and sessions:prune.'),
  schedule: createAddBlueprintCommand('schedule', 'Install a schedule kernel with a sample recurring task.'),
  storage: createAddBlueprintCommand('storage', 'Install storage scaffolding with local/public disks and a sample storage service.'),
}

const addCommand = defineCommand({
  meta: {
    name: 'add',
    description: 'Apply higher-level framework scaffolds to the current application.',
  },
  args: {
    help: {
      type: 'boolean',
      alias: 'h',
      description: 'Show available blueprints.',
    },
  },
  subCommands: addSubCommands,
  async run(ctx) {
    if (ctx.args.help || ctx.rawArgs.length === 0) {
      consola.info(`Available: ${Object.keys(addSubCommands).sort().join(', ')}`)
      await showUsage(ctx.cmd)
    }
  },
})

/**
 * citty's `--no-` branch writes the key with the prefix *stripped*, so
 * `--no-autofix` arrives as `autofix: false` and never sets `noAutofix`;
 * `--noAutofix` is the camel spelling usage printed while only it worked, still
 * honored so a script written against it keeps suppressing fixes.
 */
export function readNoAutofix(args: { autofix?: boolean; noAutofix?: boolean }): boolean {
  return args.autofix === false || Boolean(args.noAutofix)
}

const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    description: 'Upgrade Guren dependencies in the current application.',
  },
  args: {
    canary: {
      type: 'boolean',
      description: 'Pin @guren/* dependencies to the canary release tag.',
    },
    tag: {
      type: 'string',
      description: `npm dist-tag to upgrade to (default: ${DEFAULT_UPGRADE_TAG}). All @guren/* packages are aligned to it.`,
    },
    install: {
      type: 'boolean',
      description: 'Run bun install after package.json is updated.',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print the dependency changes without modifying package.json.',
    },
    json: {
      type: 'boolean',
      description: 'Print the upgrade report as JSON.',
    },
    // Positive on purpose, so citty's negation lands on the key `readNoAutofix`
    // reads. `default: true` is also what makes usage print `--no-autofix`.
    autofix: {
      type: 'boolean',
      default: true,
      description: 'Only report fixable issues without applying automatic fixes.',
    },
    'check-only': {
      type: 'boolean',
      description: 'Run compatibility and deprecation checks without modifying anything.',
    },
  },
  async run({ args }) {
    const tag = args.canary ? 'canary' : typeof args.tag === 'string' && args.tag ? args.tag : DEFAULT_UPGRADE_TAG

    const result = await upgradeCanary({
      install: Boolean(args.install),
      dryRun: Boolean(args['dry-run']),
      noAutofix: readNoAutofix(args),
      checkOnly: Boolean(args['check-only']),
      tag,
    })

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    if (result.versionCompatibility) {
      const vc = result.versionCompatibility
      if (vc.warnings.length > 0) {
        consola.box(vc.downgrade ? 'Downgrade' : 'Version compatibility')
        for (const warning of vc.warnings) {
          consola.warn(warning)
        }
      } else {
        consola.success(`Version compatible (${vc.currentVersion} -> ${vc.targetVersion})`)
      }
    }

    if (result.deprecationWarnings.length > 0) {
      consola.box('Deprecation warnings')
      for (const dep of result.deprecationWarnings) {
        consola.warn(`${dep.what} (deprecated since ${dep.since}, removed in ${dep.removedIn})`)
        consola.info(`  Replacement: ${dep.replacement}`)
        consola.info(`  Affected files: ${dep.affectedFiles.join(', ')}`)
      }
    }

    if (result.codemodResults.length > 0) {
      consola.box(args['dry-run'] ? 'Codemod preview' : 'Codemods')
      for (const codemod of result.codemodResults) {
        const prefix = codemod.status === 'applied' ? '[applied]' : codemod.status === 'pending' ? '[pending]' : '[skipped]'
        consola.info(`${prefix} ${codemod.description} (${codemod.filesAffected} files)`)
      }
    }

    if (args['check-only']) {
      consola.info('Check-only mode. No files were modified.')
      return
    }

    if (result.updatedDependencies.length === 0) {
      consola.info('No Guren dependencies needed updating.')
    } else {
      consola.box('Dependency changes')
      for (const dependency of result.updatedDependencies) {
        consola.success(`${dependency.field}: ${dependency.name} ${dependency.previousVersion} -> ${dependency.nextVersion}`)
      }
    }

    if (result.autofixes.length > 0) {
      consola.box(args['dry-run'] ? 'Autofix preview' : 'Autofixes applied')
      for (const autofix of result.autofixes) {
        const prefix = autofix.applied ? '[applied]' : '[preview]'
        consola.info(`${prefix} ${autofix.title}: ${autofix.summary}`)
      }
    }

    if (result.warnings.length > 0) {
      consola.box('Warnings')
      for (const warning of result.warnings) {
        consola.warn(`${warning.title}: ${warning.message}`)
      }
    }

    if (result.manualSteps.length > 0) {
      consola.box('Manual steps')
      for (const step of result.manualSteps) {
        consola.info(step)
      }
    }

    if (result.recommendedCommands.length > 0) {
      consola.box('Next commands')
      for (const command of result.recommendedCommands) {
        consola.info(command)
      }
    }

    if (args['dry-run']) {
      consola.info('Dry run complete. Files were not modified.')
    } else if (result.updatedDependencies.length > 0 || result.autofixes.some((autofix) => autofix.applied)) {
      consola.info(`Updated ${result.packageJsonPath}`)
    }
  },
})

const deployCommand = defineCommand({
  meta: {
    name: 'deploy',
    description: 'Generate deployment recipes for Docker, Fly.io, or Railway.',
  },
  args: {
    target: {
      type: 'string',
      description: 'Deployment target (docker, fly, railway, all)',
      default: 'docker',
    },
    app: {
      type: 'string',
      description: 'Application name used in generated config (e.g. fly.toml app name)',
    },
    port: {
      type: 'string',
      description: 'Application port for generated deployment files (default: 3333)',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing deployment files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const rawTarget = String(args.target ?? 'docker')
    const allowedTargets = new Set<DeployTarget>(['docker', 'fly', 'railway', 'all'])
    if (!allowedTargets.has(rawTarget as DeployTarget)) {
      throw new Error(`Invalid deploy target "${rawTarget}". Expected one of: docker, fly, railway, all. For Vercel, use \`bunx guren plugin @guren/plugin-vercel\`; for AWS Lambda, use \`bunx guren plugin @guren/plugin-lambda\`.`)
    }

    const port = args.port === undefined ? undefined : Number(args.port)
    if (args.port !== undefined && !Number.isInteger(port)) {
      throw new Error('The --port option must be an integer.')
    }

    const overwritten: string[] = []
    const files = await scaffoldDeploy({
      overwritten,
      target: rawTarget as DeployTarget,
      appName: args.app ? String(args.app) : undefined,
      port,
      force: Boolean(args.force),
    })

    announceWrittenFiles(files, overwritten)
  },
})

export const builtinSubCommands = {
  ...makeCommands,
  'make:adr': makeAdrCommand,
  'make:validator': makeValidatorCommand,
  'spec:generate': specGenerateCommand,
  'docs:graph': docsGraphCommand,
  plan: planCommand,
  'plan:render': planRenderCommand,
  'plan:approve': planApproveCommand,
  'plan:status': planStatusCommand,
  'plan:verify': planVerifyCommand,
  'plan:next': planNextCommand,
  'plan:scaffold': planScaffoldCommand,
  'plan:waive': planWaiveCommand,
  'plan:revise': planReviseCommand,
  'plan:close': planCloseCommand,
  'make:auth': makeAuthCommand,
  'make:agent': makeAgentCommand,
  'make:ai-agent': makeAiAgentCommand,
  'ai:eval': aiEvalCommand,
  'make:module': makeModuleCommand,
  'make:channel': makeChannelCommand,
  'make:command': makeConsoleCommandCommand,
  'make:exception': makeExceptionCommand,
  'make:factory': makeFactoryCommand,
  'make:listener': makeListenerCommand,
  'make:migration': makeMigrationCommand,
  'make:resource': makeResourceCommand,
  'make:test': makeTestCommand,
  'db:migrate': migrateCommand,
  'db:seed': seedCommand,
  'db:reset': resetCommand,
  'db:fresh': freshCommand,
  'db:rollback': rollbackCommand,
  'db:status': statusCommand,
  'queue:work': queueWorkCommand,
  'queue:failed': queueFailedCommand,
  'queue:retry': queueRetryCommand,
  'queue:flush': queueFlushCommand,
  'routes:types': routeTypesCommand,
  codegen: codegenCommand,
  'route:list': routeListCommand,
  'tool:list': toolListCommand,
  'tool:inspect': toolInspectCommand,
  'tool:call': toolCallCommand,
  'tool:log': toolLogCommand,
  'token:issue': tokenIssueCommand,
  'tool:dev': toolDevCommand,
  'openapi:generate': openApiGenerateCommand,
  'config:cache': configCacheCommand,
  'config:clear': configClearCommand,
  'config:show': configShowCommand,
  'storage:link': storageLinkCommand,
  'schedule:list': scheduleListCommand,
  'schedule:run': scheduleRunCommand,
  'health:check': healthCheckCommand,
  'lang:publish': langPublishCommand,
  'lang:list': langListCommand,
  'env:example': envExampleCommand,
  'make:lang': makeLangCommand,
  add: addCommand,
  plugin: addPluginCommand,
  doctor: doctorCommand,
  'key:generate': keyGenerateCommand,
  new: newCommand,
  upgrade: upgradeCommand,
  deploy: deployCommand,
  console: consoleCommand,
  dev: devCommand,
  'model:list': modelListCommand,
  context: contextCommand,
  introspect: introspectCommand,
  check: checkCommand,
  audit: auditCommand,
  gate: gateCommand,
  guidelines: guidelinesCommand,
  'make:feature': makeFeatureCommand,
  'agent:init': agentInitCommand,
  'agent:sync': agentSyncCommand,
}