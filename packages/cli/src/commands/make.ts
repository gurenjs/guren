import { consola } from 'consola'

import { defineCommand } from '../define-command'
import { ISSUE_REF_FORMS, splitIssueList } from '../issue-refs'
import { makeLanguage } from '../lang'
import { parseFieldsString } from '../fields'
import { announceWrittenFiles, type WriterOptions } from '../utils'
import { makeAuth } from '../make-auth'
import { makeChannel } from '../make-channel'
import { makeCommand, registerScaffoldedCommand } from '../make-command'
import { makeController } from '../make-controller'
import { makeEvent } from '../make-event'
import { makeException } from '../make-exception'
import { makeFactory } from '../make-factory'
import { makeJob } from '../make-job'
import { makeMail } from '../make-mail'
import { makeMiddleware } from '../make-middleware'
import { makeAgent } from '../make-agent'
import { makeAiAgent } from '../make-ai-agent'
import { makePolicy } from '../make-policy'
import { makeMigration } from '../make-migration'
import { makeModel } from '../make-model'
import { makeModule } from '../make-module'
import { makeNotification } from '../make-notification'
import { makeProvider } from '../make-provider'
import { makeAdr } from '../make-adr'
import { makeResource } from '../make-resource'
import { makeRoute } from '../make-route'
import { makeSeeder } from '../make-seeder'
import { makeValidator } from '../make-validator'
import { makeTest, type TestRunner } from '../make-test'
import { makeView } from '../make-view'
import { makeFeature } from '../make-feature'
import { UsageError } from '../run-cli'
import { describePath, describeMigrationsFolder } from './display-paths'
import { ATTACH_ARG, FIELDS_ARG, FORCE_ARG, MODULE_ARG, toWriterOptions } from './scaffold-options'

function createMakeCommand(spec: MakeCommandSpec) {
  const { name: commandName, description, argDescription, makeFn, resourceName, nextStep } = spec
  return defineCommand({
    meta: { name: commandName, description },
    args: {
      name: { type: 'positional', required: true, description: argDescription },
      force: FORCE_ARG,
      module: MODULE_ARG,
    },
    async run({ args }) {
      const file = await makeFn(args.name, toWriterOptions(args))
      consola.success(`${resourceName} created at ${file}`)
      if (nextStep) consola.info(nextStep)
    },
  })
}

type MakeCommandSpec = {
  name: string
  description: string
  argDescription: string
  makeFn: (name: string, options: WriterOptions) => Promise<string>
  resourceName: string
  /**
   * Printed after the success line, for a generator whose output does not work
   * until the user does something else. Only `make:route` needs one: everything
   * else here writes something the framework discovers.
   */
  nextStep?: string
}

const makeCommandSpecs: MakeCommandSpec[] = [
  { name: 'make:controller', description: 'Generate a new controller file.', argDescription: 'Controller class name', makeFn: makeController, resourceName: 'Controller' },
  { name: 'make:model', description: 'Generate a new model file.', argDescription: 'Model class name', makeFn: makeModel, resourceName: 'Model' },
  { name: 'make:view', description: 'Generate a new view component.', argDescription: 'View component path', makeFn: makeView, resourceName: 'View' },
  {
    name: 'make:route',
    description: 'Generate a new route group.',
    argDescription: 'Route group name',
    makeFn: makeRoute,
    resourceName: 'Route',
    // "your route registrar" rather than `routes/web.ts`: `--module` sends this
    // file to `modules/<name>/routes/`, mounted by the module's own `routes.ts`.
    nextStep:
      'Nothing mounts it yet (guren check reports this) — import its registerRoutes from your route '
      + "registrar and call it, passing that registrar's router.",
  },
  { name: 'make:job', description: 'Generate a new job class.', argDescription: 'Job class name', makeFn: makeJob, resourceName: 'Job' },
  { name: 'make:event', description: 'Generate a new event class.', argDescription: 'Event class name', makeFn: makeEvent, resourceName: 'Event' },
  { name: 'make:mail', description: 'Generate a new mailable class.', argDescription: 'Mail class name', makeFn: makeMail, resourceName: 'Mail' },
  { name: 'make:middleware', description: 'Generate a new middleware.', argDescription: 'Middleware name', makeFn: makeMiddleware, resourceName: 'Middleware' },
  { name: 'make:policy', description: 'Generate a new authorization policy.', argDescription: 'Policy class name', makeFn: makePolicy, resourceName: 'Policy' },
  { name: 'make:seeder', description: 'Generate a new database seeder.', argDescription: 'Seeder name', makeFn: makeSeeder, resourceName: 'Seeder' },
  { name: 'make:notification', description: 'Generate a new notification class.', argDescription: 'Notification class name', makeFn: makeNotification, resourceName: 'Notification' },
  { name: 'make:provider', description: 'Generate a new service provider.', argDescription: 'Provider class name', makeFn: makeProvider, resourceName: 'Provider' },
]

export const makeCommands = Object.fromEntries(
  makeCommandSpecs.map((spec) => [
    spec.name,
    createMakeCommand(spec),
  ]),
)

// Its own command rather than a makeCommandSpecs entry, for the extra flags.
export const makeAdrCommand = defineCommand({
  meta: {
    name: 'make:adr',
    description: 'Generate a numbered ADR under docs/adr with linkable frontmatter.',
  },
  args: {
    name: { type: 'positional', required: true, description: 'Decision title (quoted prose)' },
    entity: {
      type: 'string',
      description: 'Model class name to prefill entities:/related: with (case-insensitive).',
    },
    by: {
      type: 'string',
      description:
        'OKF actor for generated.by (human:<id>, process:<id>, or <producer>/<version>). Defaults to the git author.',
    },
    issue: {
      type: 'string',
      description: `GitHub issues or PRs to prefill issues: with, comma-separated for several. Each: ${ISSUE_REF_FORMS}.`,
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeAdr(args.name, {
      ...toWriterOptions(args),
      entity: args.entity,
      by: args.by,
      issues: splitIssueList(args.issue),
    })
    consola.success(`ADR created at ${file}`)
  },
})

// Its own command rather than a makeCommandSpecs entry, for the extra --fields.
export const makeValidatorCommand = defineCommand({
  meta: {
    name: 'make:validator',
    description: 'Generate Zod validation schemas (route params, list query, payload) for an entity.',
  },
  args: {
    name: { type: 'positional', required: true, description: 'Entity or validator class name' },
    fields: FIELDS_ARG,
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    // Parsed here so an omitted --fields means "empty payload schema" for this
    // command only (make:feature falls back to DEFAULT_FIELDS in fields.ts).
    const fields = args.fields ? parseFieldsString(args.fields) : undefined
    const file = await makeValidator(args.name, { ...toWriterOptions(args), fields })
    consola.success(`Validator created at ${file}`)
  },
})

export const makeTestCommand = defineCommand({
  meta: {
    name: 'make:test',
    description: 'Generate a new test file.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Test suite name or path',
    },
    runner: {
      type: 'string',
      description: 'Test runner to scaffold for (bun or vitest). Defaults to auto-detecting the target project.',
      valueHint: 'bun|vitest',
    },
    controller: {
      type: 'boolean',
      description: 'Scaffold a controller test in tests/controllers/ with a Controller suffix',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const runnerArg = args.runner?.toLowerCase()
    let runner: TestRunner | undefined

    if (runnerArg) {
      if (runnerArg !== 'bun' && runnerArg !== 'vitest') {
        throw new UsageError(`Invalid runner "${args.runner}". Expected one of: bun, vitest.`)
      }

      runner = runnerArg
    }

    const writerOptions = toWriterOptions(args)
    const file = await makeTest(args.name, {
      ...writerOptions,
      ...(runner ? { runner } : {}),
      controller: Boolean(args.controller),
    })
    consola.success(`Test created at ${file}`)
  },
})

export const makeAuthCommand = defineCommand({
  meta: {
    name: 'make:auth',
    description: 'Scaffold authentication controllers, views, provider, and database resources.',
  },
  args: {
    force: FORCE_ARG,
    install: {
      type: 'boolean',
      description: 'Automatically wire up auth configuration in app.ts and routes',
      alias: 'i',
    },
    minimal: {
      type: 'boolean',
      description: 'Skip registration and password reset scaffolding and generate the login-only experience',
    },
    verify: {
      type: 'boolean',
      description: 'Also scaffold email verification (requires the default, non-minimal experience)',
    },
    oauth: {
      type: 'string',
      description: 'Also scaffold OAuth login buttons for the given comma-separated providers (github, google, discord)',
    },
    'oauth-only': {
      type: 'boolean',
      description: 'Make OAuth the only sign-in method: skip password login, registration, and password reset (requires --oauth)',
    },
    session: {
      type: 'boolean',
      default: true,
      description: 'Also scaffold database-backed sessions (--no-session leaves them on the in-memory default)',
    },
  },
  async run({ args }) {
    const overwritten: string[] = []
    const files = await makeAuth({
      ...toWriterOptions(args),
      overwritten,
      install: Boolean(args.install),
      session: args.session,
      minimal: Boolean(args.minimal),
      verify: Boolean(args.verify),
      oauth: args.oauth,
      oauthOnly: Boolean(args['oauth-only']),
    })
    announceWrittenFiles(files, overwritten)
  },
})

export const makeModuleCommand = defineCommand({
  meta: {
    name: 'make:module',
    description: 'Scaffold a modules/<name>/ directory and wire it into src/app.ts.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Module name (e.g., billing)',
    },
    force: FORCE_ARG,
  },
  async run({ args }) {
    const overwritten: string[] = []
    const { moduleDir, filesCreated } = await makeModule(args.name, { ...toWriterOptions(args), overwritten })
    announceWrittenFiles(filesCreated, overwritten)
    consola.info(`Scaffold new components inside it with --module ${args.name}, e.g.:`)
    consola.info(`  bunx guren make:controller Invoice --module ${args.name}`)
    consola.info(`  bunx guren make:model Invoice --module ${args.name}`)
    consola.info(`Module directory: ${moduleDir}`)
  },
})

export const makeAgentCommand = defineCommand({
  meta: {
    name: 'make:agent',
    description: 'Scaffold a durable agent, register it in config/agents.ts, and pin its boundary.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Agent class name (e.g., Triager)',
    },
    force: FORCE_ARG,
    // Declared so the refusal is a documented argument rather than parser
    // leniency: a user who passes it deserves `makeAgent`'s reason, not
    // "unknown flag". The description is overridden because the shared one
    // promises a placement this command always refuses.
    module: {
      ...MODULE_ARG,
      description:
        'Not supported for agents: the registry is one project-root config/agents.ts, '
        + 'which guren cloudflare:build reads.',
    },
  },
  async run({ args }) {
    const { file, patches, notes } = await makeAgent(args.name, toWriterOptions(args))
    consola.success(`Created ${file}`)

    for (const patch of patches) {
      if (patch.status === 'created') consola.success(`Created ${patch.file}`)
      else if (patch.status === 'patched') consola.success(`Updated ${patch.file}`)
      else if (patch.status === 'skipped') consola.info(`Left ${patch.file} alone: ${patch.reason}.`)
      else {
        // Never silent. A registration this could not write is an agent the
        // Cloudflare build will not export, and the app would look wired.
        consola.warn(`Could not update ${patch.file} — ${patch.reason}. Add this by hand:`)
        consola.log(patch.snippet)
      }
    }

    for (const note of notes) {
      consola.info(note)
    }
  },
})

export const makeAiAgentCommand = defineCommand({
  meta: {
    name: 'make:ai-agent',
    description: 'Scaffold an in-process AI agent (RFC 0029) under app/Ai/Agents. For a durable Workers agent, use make:agent.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Agent class name (e.g., SupportTriager)',
    },
    tools: {
      type: 'string',
      description: 'Comma-separated agent tool names for appTools(), checked against the routes (e.g., "tickets_show,tickets_update").',
    },
    output: {
      type: 'boolean',
      description: 'Declare a structured output with a Zod schema stub.',
    },
    test: {
      type: 'boolean',
      description: 'Also write a test that scripts the agent with app.fakeAi().',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const { files, notes } = await makeAiAgent(args.name, {
      ...toWriterOptions(args),
      tools: args.tools,
      output: Boolean(args.output),
      test: Boolean(args.test),
    })
    for (const file of files) consola.success(`Created ${file}`)
    for (const note of notes) consola.warn(note)
  },
})

export const makeListenerCommand = defineCommand({
  meta: {
    name: 'make:listener',
    description: 'Generate a new event listener class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Listener class name',
    },
    event: {
      type: 'string',
      description: 'Event class to listen for',
      alias: 'e',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const { makeListener: makeListenerFn } = await import('../make-listener')
    const file = await makeListenerFn(args.name, {
      ...toWriterOptions(args),
      event: args.event,
    })
    consola.success(`Listener created at ${file}`)
  },
})

export const makeResourceCommand = defineCommand({
  meta: {
    name: 'make:resource',
    description: 'Generate a new API resource class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Resource class name',
    },
    model: {
      type: 'string',
      description: 'Model class this resource wraps',
      alias: 'm',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeResource(args.name, {
      ...toWriterOptions(args),
      model: args.model,
    })
    consola.success(`Resource created at ${file}`)
  },
})

export const makeFactoryCommand = defineCommand({
  meta: {
    name: 'make:factory',
    description: 'Generate a new model factory class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Factory class name',
    },
    model: {
      type: 'string',
      description: 'Model class this factory creates',
      alias: 'm',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeFactory(args.name, {
      ...toWriterOptions(args),
      model: args.model,
    })
    consola.success(`Factory created at ${file}`)
  },
})

export const makeConsoleCommandCommand = defineCommand({
  meta: {
    name: 'make:command',
    description: 'Generate a new console command.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Command class name',
    },
    command: {
      type: 'string',
      description: 'Console command name (e.g., users:import)',
      alias: 'c',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const options = {
      ...toWriterOptions(args),
      command: args.command,
    }
    const file = await makeCommand(args.name, options)
    consola.success(`Command created at ${file}`)
    await registerScaffoldedCommand(args.name, file, options)
  },
})

export const makeChannelCommand = defineCommand({
  meta: {
    name: 'make:channel',
    description: 'Generate a new broadcasting channel.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Channel class name',
    },
    channel: {
      type: 'string',
      description: 'Channel name for broadcasting',
    },
    private: {
      type: 'boolean',
      description: 'Create a private channel',
      alias: 'p',
    },
    presence: {
      type: 'boolean',
      description: 'Create a presence channel',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeChannel(args.name, {
      ...toWriterOptions(args),
      channel: args.channel,
      private: Boolean(args.private),
      presence: Boolean(args.presence),
    })
    consola.success(`Channel created at ${file}`)
  },
})

function parseStatusArg(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const status = Number(value)
  if (!/^\d+$/.test(value) || status < 400 || status > 599) {
    throw new UsageError(`Invalid --status "${value}". Expected an HTTP error status code between 400 and 599.`)
  }
  return status
}

export const makeExceptionCommand = defineCommand({
  meta: {
    name: 'make:exception',
    description: 'Generate a new exception class.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Exception class name',
    },
    status: {
      type: 'string',
      description: 'HTTP status code',
      alias: 's',
    },
    message: {
      type: 'string',
      description: 'Default error message',
      alias: 'm',
    },
    force: FORCE_ARG,
    module: MODULE_ARG,
  },
  async run({ args }) {
    const file = await makeException(args.name, {
      ...toWriterOptions(args),
      status: parseStatusArg(args.status),
      message: args.message,
    })
    consola.success(`Exception created at ${file}`)
  },
})

export const makeMigrationCommand = defineCommand({
  meta: {
    name: 'make:migration',
    description: 'Generate a new SQL migration file using drizzle-kit.',
  },
  args: {
    // A `string`, not a `positional`: declared positional, `--name x` leaves
    // `args` with neither a `name` key nor the value in `_`, and no
    // unknown-flag error, so drizzle-kit invents its own name. Both spellings
    // are documented, and a `string` arg still leaves the bare positional in
    // `_` for `run()` below.
    name: {
      type: 'string',
      description: 'Migration name, as `--name <name>` or a bare positional',
      valueHint: 'add_posts_table',
    },
    schema: {
      type: 'string',
      description: 'Override the schema file path',
      valueHint: 'db/schema.ts',
    },
    out: {
      type: 'string',
      description: 'Override the migrations output directory',
      valueHint: 'db/migrations',
    },
    dialect: {
      type: 'string',
      description: 'Database dialect, for apps with no drizzle config to declare one',
      valueHint: 'postgresql',
    },
  },
  async run({ args }) {
    // Any of these three drops drizzle-kit's `--config`, which it refuses
    // alongside other flags, so `makeMigration` reassembles the config's
    // dialect, schema and out onto the command line instead.
    const result = await makeMigration({
      name: args.name ?? args._[0],
      schema: args.schema,
      out: args.out,
      // `--dialect` reaches drizzle-kit verbatim, so a repeated flag would
      // arrive comma-joined as a dialect nothing accepts.
      dialect: args.dialect,
    })

    // Overrides drop `--config`, and `generate` has no flag for every field it
    // would have read, so name what was left behind.
    if (result.configUnreadable) {
      consola.warn(
        'Your drizzle config could not be loaded, so the schema and output paths fell back to ' +
          'their defaults — the migration may not describe the schema your config points at. ' +
          'Fix the config so it imports cleanly, or pass --schema/--out explicitly.',
      )
    }

    if (result.droppedConfigFields.length > 0) {
      consola.warn(
        `Your drizzle config sets ${result.droppedConfigFields.join(', ')}, which cannot be passed ` +
          'alongside --schema/--out/--dialect — drizzle-kit used its default instead. ' +
          'Drop the overrides to have the config applied in full.',
      )
    }

    // drizzle-kit exits 0 for "No schema changes, nothing to migrate." too, so
    // the ✔ below is reported off what it wrote, not off the exit code. An
    // unresolvable out dir leaves `migrationsFolder` unset.
    if (result.migrationsFolder && result.created.length === 0) {
      const schema = result.schemaPath ? describePath(result.schemaPath) : 'your schema'
      consola.warn(
        `No migration generated in ${describeMigrationsFolder(result.migrationsFolder)} — ` +
          `${schema} has no changes since the last one.`,
      )
      consola.info(`Edit \`${schema}\` to change your tables, then re-run \`bun run db:make\`.`)
      return
    }

    consola.success(
      result.created.length > 0 ? `Migration generated: ${result.created.join(', ')}.` : 'Migration generated.',
    )
  },
})

export const makeLangCommand = defineCommand({
  meta: {
    name: 'make:lang',
    description: 'Create a new language locale.',
  },
  args: {
    locale: {
      type: 'positional',
      required: true,
      description: 'Locale code (e.g., ja, es, pt-BR)',
    },
    path: {
      type: 'string',
      description: 'Path to the language files directory',
      valueHint: 'lang',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
    },
    from: {
      type: 'string',
      description: 'Copy structure from existing locale',
    },
    force: FORCE_ARG,
  },
  async run({ args }) {
    makeLanguage(args.locale, {
      path: args.path,
      appRoot: args.app,
      from: args.from,
      force: args.force,
    })
  },
})

export const makeFeatureCommand = defineCommand({
  meta: {
    name: 'make:feature',
    description: 'Scaffold a complete CRUD feature with all components.',
  },
  args: {
    name: {
      type: 'positional',
      required: true,
      description: 'Feature name (singular, e.g., Product).',
    },
    fields: FIELDS_ARG,
    attach: ATTACH_ARG,
    force: FORCE_ARG,
    test: {
      type: 'boolean',
      description: 'Also generate a controller test in tests/controllers/ (as make:test --controller).',
    },
    factory: {
      type: 'boolean',
      description: 'Also generate a model factory in db/factories.',
    },
    public: {
      type: 'boolean',
      description: 'Skip authentication checks in mutating actions (default: auth required).',
    },
    policy: {
      type: 'boolean',
      description: 'Also generate an authorization policy and enforce it in store/update/destroy.',
    },
    prototype: {
      type: 'boolean',
      description: 'Prototype-first (RFC 0021): pages, validator, page-data type and fixture entries only; no model, migration or controller. Needs `guren add prototype`.',
    },
    module: MODULE_ARG,
  },
  async run({ args }) {
    await makeFeature(args.name as string, {
      fields: args.fields,
      attach: args.attach,
      ...toWriterOptions(args),
      withTest: Boolean(args.test),
      withFactory: Boolean(args.factory),
      publicAccess: Boolean(args.public),
      withPolicy: Boolean(args.policy),
      prototype: Boolean(args.prototype),
    })
  },
})
