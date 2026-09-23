import { describe, expect, it } from 'bun:test'
import { readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  SERVER_DIST_ENTRY,
  SKIPPED_GENERATORS,
  TSC_TIMEOUT,
  assertWorkspaceBuilt,
  checkTypes,
  createTempWorkspace,
  linkWorkspacePackage,
  renderedAppCompilerOptions,
  seedApiOnlyApp,
  seedInertiaApp,
  writeWorkspaceFiles,
} from './helpers'
import { collectFiles, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES, toPosixRelative } from '../src/discovery'
import { builtinSubCommands } from '../src/commands'
import { parseFieldsString, type FieldDefinition, type FieldType } from '../src/fields'
import { collectionSlug, schemaIdentifierFor, tableNameFor } from '../src/inflect'
import { ensurePgImports } from '../src/patch-helpers'
import { camelCase, pascalCase } from '../src/utils'
import { loadScaffoldTemplate } from '../src/scaffold-templates'
import { generateApiClientTypes } from '../src/api-client-types'
import { generateDataTypes } from '../src/data-types'
import { generatePageTypes } from '../src/pages-types'
import { generateRouteTypes } from '../src/routes-types'
import { buildRouteRegistrationHint, makeFeature, type MakeFeatureOptions } from '../src/make-feature'
import { makeChannel } from '../src/make-channel'
import { makeCommand } from '../src/make-command'
import { makeController } from '../src/make-controller'
import { makeEvent } from '../src/make-event'
import { makeException } from '../src/make-exception'
import { makeFactory } from '../src/make-factory'
import { makeJob } from '../src/make-job'
import { makeListener } from '../src/make-listener'
import { makeMail } from '../src/make-mail'
import { makeMiddleware } from '../src/make-middleware'
import { makeModel } from '../src/make-model'
import { makeModule } from '../src/make-module'
import { makeNotification } from '../src/make-notification'
import { makePolicy } from '../src/make-policy'
import { makeProvider } from '../src/make-provider'
import { makeResource } from '../src/make-resource'
import { makeRoute } from '../src/make-route'
import { makeSeeder } from '../src/make-seeder'
import { makeTest } from '../src/make-test'
import { makeValidator } from '../src/make-validator'
import { makeView } from '../src/make-view'

/**
 * The compile gate for every `make:*` generator: each template interpolates the
 * entity name, so none can ship as a real source for `typecheck:templates`.
 * Renders into a temp app and typechecks it as one program, as
 * scaffold-builder-typecheck.test.ts does for make:auth. The covered set derives
 * from `builtinSubCommands`, so a new generator fails here until it joins the matrix.
 */

const cliRoot = resolve(import.meta.dir, '..')

/** What the rendered app's import graph resolves at runtime, beyond the server every CLI test needs. */
const LINKED_DIST_ENTRIES = [SERVER_DIST_ENTRY, ...['core', 'orm'].map((name) => join(cliRoot, `../${name}/dist/index.js`))]

/** Every FIELD_TYPES member plus a nullable, so each column mapper branch renders. */
const ALL_FIELDS = 'title:string,count:number,published:boolean,body:text,postedAt:date,meta:json,subtitle:string?'

/**
 * Bun resolves a rendered app's `@/` imports through the nearest tsconfig, and
 * the app's own routes file is *imported* by route codegen, so the rendered
 * controllers, models and validators evaluate for real. That import graph reaches
 * `@guren/core`, `@guren/orm` and `zod`, which a temp directory cannot resolve.
 */
async function prepareRenderedApp(dir: string): Promise<void> {
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }))
  await linkWorkspacePackage('core', dir)
  await linkWorkspacePackage('orm', dir)
  await symlink(join(cliRoot, 'node_modules/zod'), join(dir, 'node_modules/zod'), 'dir')
}

const PG_TABLE_BUILDERS = ['boolean', 'integer', 'jsonb', 'pgTable', 'serial', 'text', 'timestamp']

const PG_COLUMN: Record<FieldType, (column: string) => string> = {
  string: (column) => `text('${column}')`,
  text: (column) => `text('${column}')`,
  number: (column) => `integer('${column}')`,
  boolean: (column) => `boolean('${column}')`,
  date: (column) => `timestamp('${column}', { withTimezone: true })`,
  json: (column) => `jsonb('${column}')`,
}

/** The table an author declares for a feature, in the pg shape the resource blueprint appends. */
function pgTableSource(singular: string, fields: FieldDefinition[]): string {
  const columns = fields.map((field) => {
    const column = field.name.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`)
    const builder = PG_COLUMN[field.type](column)
    return `  ${field.name}: ${field.nullable ? builder : `${builder}.notNull()`},`
  })
  return `export const ${schemaIdentifierFor(singular)} = pgTable('${tableNameFor(singular)}', {
  id: serial('id').primaryKey(),
${columns.join('\n')}
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
`
}

/** A `db/schema.ts` holding `tableSource` after `existing`, with the pg builders the table needs imported once. */
function pgSchemaSource(tableSource: string, existing = ''): string {
  return `${ensurePgImports(existing, PG_TABLE_BUILDERS)}\n${tableSource}`
}

/**
 * The schema and config `guren add attachments` leaves behind: the typecheck
 * fixture's pg table (pinned to the blueprint in scaffold-output.test.ts) and
 * the shipped config template, which the `--attach` preflight reads and tsc checks.
 */
async function seedAttachmentsApp(dir: string, tableSource: string): Promise<void> {
  const fixture = await readFile(join(import.meta.dir, 'fixtures/scaffold-typecheck/attachments/db/schema.ts'), 'utf8')
  await writeWorkspaceFiles(dir, {
    'db/schema.ts': pgSchemaSource(tableSource, fixture),
    'config/attachments.ts': loadScaffoldTemplate('attachments/config/attachments.ts'),
  })
}

/**
 * The registrar an author writes from the block `make:feature` prints, hung off
 * the file's own `router`. `controllerDir` is where the controllers sit relative
 * to the routes file (`../app` at the root, `./app` inside a module).
 */
function routesSource(feature: Parameters<typeof buildRouteRegistrationHint>[0], registrar: string, controllerDir: string): string {
  const coreImports = feature.withAuth ? 'Router, requireAuthenticated' : 'Router'
  const body = buildRouteRegistrationHint(feature).map((line) => `  ${line}`).join('\n')
  return `import { ${coreImports} } from '@guren/core'
import ${feature.singular}Controller from '${controllerDir}/Http/Controllers/${feature.singular}Controller.js'
import { ${feature.singular}PayloadSchema } from '${controllerDir}/Http/Validators/${feature.singular}Validator.js'

export function ${registrar}(router: Router): void {
${body}
}

export default ${registrar}
`
}

/** `guren codegen`'s route-dependent half, in its order: pages first, since the routes file's controllers import them. */
async function runCodegen(appRoot: string): Promise<void> {
  await generatePageTypes({ appRoot, extractProps: true, force: true })
  const { definitions } = await generateRouteTypes({ appRoot, routesFile: 'routes/web.ts', force: true })
  const { definitions: resources } = await generateDataTypes({ appRoot, force: true })
  await generateApiClientTypes(definitions, { appRoot, resources, force: true })
}

async function typecheckRenderedApp(dir: string, created: string[]): Promise<void> {
  const rootNames = await collectFiles(dir, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES)
  // Everything the generator wrote must reach the program; a walk that skipped
  // a generated subtree would be green for the wrong reason.
  const collected = rootNames.map((file) => toPosixRelative(dir, file))
  for (const path of created) {
    expect(collected).toContain(path)
  }
  expect(checkTypes(rootNames, renderedAppCompilerOptions(dir))).toEqual([])
}

/** `created` paths relative to cwd: the macOS tmpdir is a symlink and the generators report the realpath. */
function relativeToCwd(files: string[]): string[] {
  return files.map((file) => toPosixRelative(process.cwd(), file))
}

interface FeatureCombo {
  label: string
  singular: string
  fields: string
  options: Omit<MakeFeatureOptions, 'fields' | 'announce'>
  /** Files the combo must have written: the branch it exists to reach. */
  expectedWrites: string[]
}

const featureCombos: FeatureCombo[] = [
  {
    label: 'policy, test, factory, every field type',
    singular: 'Post',
    fields: ALL_FIELDS,
    options: { withPolicy: true, withTest: true, withFactory: true },
    expectedWrites: ['app/Policies/PostPolicy.ts', 'tests/Post.test.ts', 'db/factories/PostFactory.ts', 'app/Http/Controllers/PostController.ts'],
  },
  {
    label: 'public, with a factory, in a module',
    singular: 'Invoice',
    fields: 'title:string,paidAt:date?',
    options: { publicAccess: true, withFactory: true, root: 'billing' },
    // A module's factory imports its model by a path relative to the module; this combo compiles that path.
    expectedWrites: ['modules/billing/app/Http/Controllers/InvoiceController.ts', 'modules/billing/db/factories/InvoiceFactory.ts', 'resources/js/pages/billing/invoices/Index.tsx'],
  },
  {
    label: 'attachments',
    singular: 'Photo',
    fields: 'title:string,caption:text?',
    options: { attach: 'cover:one,images:many' },
    expectedWrites: ['app/Models/Photo.ts', 'app/Http/Controllers/PhotoController.ts'],
  },
]

describe('rendered make:feature output typechecks', () => {
  for (const combo of featureCombos) {
    it(
      `make:feature ${combo.label}`,
      async () => {
        assertWorkspaceBuilt(LINKED_DIST_ENTRIES)
        const workspace = await createTempWorkspace(`guren-typecheck-feature-${combo.singular.toLowerCase()}-`)
        try {
          await seedInertiaApp(workspace.dir)
          await prepareRenderedApp(workspace.dir)
          const fields = parseFieldsString(combo.fields)
          const routeName = collectionSlug(combo.singular)
          const feature = { singular: combo.singular, routeName, routeVar: camelCase(routeName), withAuth: !combo.options.publicAccess }

          if (combo.options.attach) {
            await seedAttachmentsApp(workspace.dir, pgTableSource(combo.singular, fields))
          } else if (combo.options.root) {
            // The registrar make:module wrote and its index.ts imports, rewritten with the feature's routes.
            await makeModule(combo.options.root)
            await writeWorkspaceFiles(workspace.dir, {
              [`modules/${combo.options.root}/db/schema.ts`]: pgSchemaSource(pgTableSource(combo.singular, fields)),
              [`modules/${combo.options.root}/routes.ts`]: routesSource(feature, `register${pascalCase(combo.options.root)}Routes`, './app'),
            })
          } else {
            await writeWorkspaceFiles(workspace.dir, { 'db/schema.ts': pgSchemaSource(pgTableSource(combo.singular, fields)) })
          }
          if (!combo.options.root) {
            await writeWorkspaceFiles(workspace.dir, { 'routes/web.ts': routesSource(feature, 'registerWebRoutes', '../app') })
          }

          const created = relativeToCwd(await makeFeature(combo.singular, { ...combo.options, fields: combo.fields, announce: false, force: true }))
          for (const path of combo.expectedWrites) {
            expect(created).toContain(path)
          }

          await runCodegen(workspace.dir)
          await typecheckRenderedApp(workspace.dir, created)
        } finally {
          await workspace.cleanup()
        }
      },
      TSC_TIMEOUT,
    )
  }
})

/**
 * One workspace, every single-file generator, one program: a generator whose
 * output references another's (make:route its controller, make:resource its
 * model) is rendered beside it, as an author would. Keyed by the `make:*` name so
 * the exhaustiveness check below can read the matrix.
 */
const singleFileRenders: Array<[string, () => Promise<unknown>]> = [
  ['make:channel', () => makeChannel('Orders')],
  ['make:channel --private', () => makeChannel('UserFeed', { channel: 'users.{id}.feed', private: true })],
  ['make:channel --presence', () => makeChannel('Room', { presence: true })],
  ['make:command', () => makeCommand('SendDigest')],
  ['make:event', () => makeEvent('OrderShipped')],
  ['make:listener', () => makeListener('SendReceipt', { event: 'OrderShipped' })],
  ['make:listener without an event', () => makeListener('AuditEverything')],
  ['make:exception', () => makeException('PaymentFailed', { status: 402, message: 'Payment failed' })],
  ['make:factory', () => makeFactory('Post')],
  ['make:job', () => makeJob('ProcessUpload')],
  ['make:mail', () => makeMail('WelcomeMail')],
  ['make:middleware', () => makeMiddleware('EnsureTeam')],
  ['make:model', () => makeModel('Post')],
  ['make:module', () => makeModule('Billing')],
  ['make:notification', () => makeNotification('InvoicePaid')],
  ['make:policy', () => makePolicy('Post')],
  ['make:provider', () => makeProvider('Billing')],
  ['make:resource', () => makeResource('Post')],
  ['make:seeder', () => makeSeeder('Posts')],
  ['make:test', () => makeTest('Post')],
  ['make:test --controller', () => makeTest('Post', { controller: true })],
  ['make:validator', () => makeValidator('Post', { fields: parseFieldsString(ALL_FIELDS) })],
  // The page make:controller renders, then the controller make:route mounts.
  ['make:view', () => makeView('admin/Index')],
  ['make:controller', () => makeController('Admin')],
  ['make:route', () => makeRoute('admin')],
]

/**
 * What an app does with the job and notification rendered above. Each file
 * compiles alone whatever it extends; only a use tells a class the queue and
 * the notification manager accept from one they reject.
 */
const QUEUE_AND_NOTIFICATION_USE = `import { NotificationManager, registerJob, registerNotification, type Notifiable } from '@guren/core'
import { ProcessUploadJob } from '../Jobs/ProcessUploadJob'
import { InvoicePaidNotification } from '../Notifications/InvoicePaidNotification'

registerJob(ProcessUploadJob)
registerNotification(InvoicePaidNotification)

export async function deliver(notifications: NotificationManager, user: Notifiable): Promise<void> {
  await ProcessUploadJob.dispatch({ uploadId: 1 })
  await notifications.send(user, new InvoicePaidNotification({ invoiceId: 1 }))
}
`

/** Generators this gate leaves to another, by name so a stale exemption fails. */
const COVERED_ELSEWHERE: Record<string, string> = {
  ...SKIPPED_GENERATORS,
  'make:auth': 'scaffold-builder-typecheck.test.ts renders its flag combinations',
  'make:agent': 'make-agent.test.ts typechecks the class against the Workers types it needs',
  'make:ai-agent': 'make-ai-agent.test.ts typechecks the agent and its test',
}

describe('rendered single-file make:* output typechecks', () => {
  it('exercises every registered make:* generator, or names why not', () => {
    const registered = Object.keys(builtinSubCommands).filter((name) => name.startsWith('make:'))
    const exercised = new Set(['make:feature', ...singleFileRenders.map(([label]) => label.split(' ')[0])])

    const uncovered = registered.filter((name) => !exercised.has(name) && !(name in COVERED_ELSEWHERE))
    expect(uncovered).toEqual([])

    const stale = [...exercised, ...Object.keys(COVERED_ELSEWHERE)].filter((name) => !registered.includes(name))
    expect(stale).toEqual([])
  })

  it(
    'every single-file generator, rendered into one Inertia app',
    async () => {
      const workspace = await createTempWorkspace('guren-typecheck-make-')
      try {
        await seedInertiaApp(workspace.dir)
        const created: string[] = []
        for (const [, render] of singleFileRenders) {
          const result = await render()
          created.push(...relativeToCwd(typeof result === 'string' ? [result] : (result as { filesCreated: string[] }).filesCreated))
        }
        // Two renders writing one path would let the later hide the earlier from the gate.
        expect(new Set(created).size).toBe(created.length)
        await writeWorkspaceFiles(workspace.dir, { 'app/Providers/QueueAndNotificationUse.ts': QUEUE_AND_NOTIFICATION_USE })

        await generatePageTypes({ appRoot: workspace.dir, extractProps: true, force: true })
        await typecheckRenderedApp(workspace.dir, created)
      } finally {
        await workspace.cleanup()
      }
    },
    TSC_TIMEOUT,
  )

  it(
    'make:controller on an API-only app renders the JSON dialect',
    async () => {
      const workspace = await createTempWorkspace('guren-typecheck-make-api-')
      try {
        await seedApiOnlyApp(workspace.dir)
        const created = relativeToCwd([await makeController('Widget')])
        expect(created).toEqual(['app/Http/Controllers/WidgetController.ts'])
        await typecheckRenderedApp(workspace.dir, created)
      } finally {
        await workspace.cleanup()
      }
    },
    TSC_TIMEOUT,
  )
})
