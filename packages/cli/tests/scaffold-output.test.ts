import { describe, expect, it } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  CLI_DIST_BIN,
  PG_SCHEMA_FIXTURE,
  SERVER_DIST_ENTRY,
  assertWorkspaceBuilt,
  createTempWorkspace,
  seedApiOnlyApp,
  seedAttachmentsConfig,
  seedInertiaApp,
} from './helpers'
import { parseSourceFile } from '../src/parse-cache'
import { collectFiles, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES, toPosixRelative } from '../src/discovery'
import { builtinSubCommands } from '../src/commands'
import { makeAuth, type MakeAuthOptions } from '../src/make-auth'
import { runBlueprint } from '../src/blueprints'
import { makeFeature } from '../src/make-feature'
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
import { FIELD_TYPES, parseFieldsString } from '../src/fields'
import { generatePageTypes } from '../src/pages-types'

/**
 * The syntax gate for every generator: render representative outputs and require
 * each generated .ts/.tsx to parse. templates/scaffold/ gets the stronger
 * `typecheck:templates` pass and make:auth's builders get
 * scaffold-builder-typecheck.test.ts; every other builder's output exists only
 * at generation time. The covered set derives from `builtinSubCommands`, so a
 * new `make:*` fails here until it joins the matrix or names its reason.
 */

/** Generators with no TypeScript output — nothing for a parse gate to check. */
const SKIPPED_GENERATORS: Record<string, string> = {
  'make:adr': 'markdown output',
  'make:migration': 'SQL migration output',
  'make:lang': 'JSON translation catalogs',
}

/** Exercises every FIELD_TYPES member plus a nullable — guarded below. */
const ALL_FIELDS = 'title:string,count:number,published:boolean,body:text,postedAt:date,meta:json,subtitle:string?'

const SCAFFOLD_TEMPLATE_ROOT = join(import.meta.dir, '../templates/scaffold')
const AUTH_TEMPLATE_ROOT = join(SCAFFOLD_TEMPLATE_ROOT, 'auth')
const SCAFFOLD_FIXTURE_ROOT = join(import.meta.dir, 'fixtures/scaffold-typecheck')

/** The fixture files carry an explanatory header the rendered output lacks. */
function stripLeadingComments(source: string): string {
  const lines = source.split('\n')
  let start = 0
  while (start < lines.length && (lines[start].startsWith('//') || lines[start] === '')) {
    start++
  }
  return lines.slice(start).join('\n')
}

/** Every importable file under `root`, as POSIX paths relative to it. */
async function relativeSourcePaths(root: string): Promise<string[]> {
  return (await collectFiles(root, IMPORTABLE_EXTENSIONS)).map((file) => toPosixRelative(root, file))
}

/**
 * Every .ts/.tsx in the workspace that fails to parse (empty = green).
 * `collectFiles` skips dotfiles and .d.ts, which no generator here emits.
 */
async function unparseableSources(dir: string): Promise<string[]> {
  const failures: string[] = []
  for (const file of await collectFiles(dir, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES)) {
    const source = await readFile(file, 'utf8')
    if (parseSourceFile(source, file) === null) {
      failures.push(toPosixRelative(dir, file))
    }
  }
  return failures
}

async function expectAllOutputsParse(
  prefix: string,
  run: () => Promise<unknown>,
  seed?: (dir: string) => Promise<void>,
): Promise<string> {
  const workspace = await createTempWorkspace(prefix)
  try {
    await seed?.(workspace.dir)
    await run()
    expect(await unparseableSources(workspace.dir)).toEqual([])
    return workspace.dir
  } finally {
    await workspace.cleanup()
  }
}

const authCombos: Array<[string, MakeAuthOptions]> = [
  ['default', {}],
  ['minimal', { minimal: true }],
  ['verify', { verify: true }],
  ['oauth', { oauth: 'github,google,discord' }],
  ['oauth-verify', { oauth: 'github', verify: true }],
  ['oauth-only', { oauth: 'github,google', oauthOnly: true }],
]

const singleFileCases: Array<[string, () => Promise<unknown>]> = [
  ['make:channel', () => makeChannel('Orders')],
  ['make:command', () => makeCommand('SendDigest')],
  ['make:event', () => makeEvent('OrderShipped')],
  ['make:exception', () => makeException('PaymentFailed')],
  ['make:factory', () => makeFactory('Post')],
  ['make:job', () => makeJob('ProcessUpload')],
  ['make:listener', () => makeListener('SendReceipt')],
  ['make:mail', () => makeMail('WelcomeMail')],
  ['make:middleware', () => makeMiddleware('EnsureTeam')],
  ['make:model', () => makeModel('Post')],
  ['make:module', () => makeModule('Billing')],
  ['make:notification', () => makeNotification('InvoicePaid')],
  ['make:policy', () => makePolicy('Post')],
  ['make:provider', () => makeProvider('Billing')],
  ['make:resource', () => makeResource('Post')],
  ['make:route', () => makeRoute('admin')],
  ['make:seeder', () => makeSeeder('Posts')],
  ['make:test', () => makeTest('Post')],
  ['make:test --controller', () => makeTest('Post', { controller: true })],
  ['make:validator with every field type', () => makeValidator('Post', { fields: parseFieldsString(ALL_FIELDS) })],
  ['make:view', () => makeView('posts/Index')],
]

/** Filled while the auth combos run; the reachability gate below reads it. */
const writtenAuthTemplatePaths = new Set<string>()

describe('generated sources parse', () => {
  it('covers every field type in one fields string', () => {
    const types = new Set(parseFieldsString(ALL_FIELDS).map((field) => field.type))
    expect([...types].sort()).toEqual([...FIELD_TYPES].sort())
  })

  it('exercises every registered make:* generator, or names why not', () => {
    const registered = Object.keys(builtinSubCommands).filter((name) => name.startsWith('make:'))
    const exercised = new Set([
      'make:auth',
      'make:feature',
      'make:controller',
      ...singleFileCases.map(([label]) => label.split(' ')[0]),
    ])

    const uncovered = registered.filter((name) => !exercised.has(name) && !(name in SKIPPED_GENERATORS))
    expect(uncovered).toEqual([])

    const stale = [...exercised, ...Object.keys(SKIPPED_GENERATORS)].filter((name) => !registered.includes(name))
    expect(stale).toEqual([])
  })

  for (const [label, options] of authCombos) {
    it(`make:auth ${label}`, async () => {
      const templatePaths = await relativeSourcePaths(AUTH_TEMPLATE_ROOT)
      await expectAllOutputsParse(
        `guren-parse-auth-${label}-`,
        async () => {
          await makeAuth({ ...options, force: true })
          for (const path of templatePaths) {
            if (await Bun.file(join(process.cwd(), path)).exists()) {
              writtenAuthTemplatePaths.add(path)
            }
          }
        },
        seedInertiaApp,
      )
    })
  }

  // Runs after the combos above (bun executes a file's tests in declaration
  // order): a template no combo writes is dead weight that still ships.
  it('every shipped auth template is written by some flag combination', async () => {
    const templatePaths = await relativeSourcePaths(AUTH_TEMPLATE_ROOT)
    expect(templatePaths.length).toBeGreaterThan(0)
    expect(templatePaths.filter((path) => !writtenAuthTemplatePaths.has(path))).toEqual([])
  })

  it('make:feature with every field type, policy, and tests', async () => {
    await expectAllOutputsParse('guren-parse-feature-', () =>
      makeFeature('Post', { fields: ALL_FIELDS, withPolicy: true, withTest: true, withFactory: true }))
  })

  it('make:feature public, in a module', async () => {
    await expectAllOutputsParse('guren-parse-feature-module-', () =>
      makeFeature('Invoice', { fields: 'title:string,paidAt:date?', publicAccess: true, root: 'billing' }))
  })

  // Seeded with a configureAttachments() config because the flag refuses an
  // app without one — the seed itself is parsed by the gate too.
  it('make:feature with attachments', async () => {
    await expectAllOutputsParse(
      'guren-parse-feature-attach-',
      () => makeFeature('Post', { fields: 'title:string', attach: 'cover:one,images:many' }),
      seedAttachmentsConfig,
    )
  })

  it('make:controller (Inertia dialect)', async () => {
    await expectAllOutputsParse('guren-parse-controller-', () => makeController('Widget'))
  })

  it('make:controller (JSON dialect on an API-only app)', async () => {
    await expectAllOutputsParse('guren-parse-controller-api-', () => makeController('Widget'), seedApiOnlyApp)
  })

  for (const [label, run] of singleFileCases) {
    it(label, async () => {
      await expectAllOutputsParse(`guren-parse-${label.replace(/[^a-z]+/g, '-')}-`, run)
    })
  }
})

describe('shipped templates reach published users', () => {
  // Everything above imports make-auth from src, which resolves templates
  // against the source tree; these two see a template missing from the build.

  it('the built CLI resolves templates from dist', async () => {
    assertWorkspaceBuilt([SERVER_DIST_ENTRY, CLI_DIST_BIN])
    const workspace = await createTempWorkspace('guren-dist-auth-')
    try {
      await seedInertiaApp(workspace.dir)
      const proc = Bun.spawn(['bun', CLI_DIST_BIN, 'make:auth', '--force'], {
        cwd: workspace.dir,
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const stderr = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(0)
      expect(stderr).not.toContain('ENOENT')

      const written = await readFile(join(workspace.dir, 'config/mail.ts'), 'utf8')
      expect(written).toBe(await readFile(join(AUTH_TEMPLATE_ROOT, 'config/mail.ts'), 'utf8'))
    } finally {
      await workspace.cleanup()
    }
  }, 30_000)

  it('the npm tarball packs every scaffold template', async () => {
    const proc = Bun.spawn(['bun', 'pm', 'pack', '--dry-run'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const listing = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(listing).toContain('dist/bin.js')

    const templatePaths = (await collectFiles(SCAFFOLD_TEMPLATE_ROOT, IMPORTABLE_EXTENSIONS))
      .map((file) => toPosixRelative(join(import.meta.dir, '..'), file))
    expect(templatePaths.length).toBeGreaterThan(0)
    expect(templatePaths.filter((path) => !listing.includes(path))).toEqual([])
  }, 30_000)
})

describe('scaffold-typecheck fixture stays pinned to the builders', () => {
  // The companions in tests/fixtures/scaffold-typecheck/auth are renders of
  // make-auth's *builders*, so a builder change has to land in the fixture too —
  // this is the test that says so.
  const fixtureRoot = join(SCAFFOLD_FIXTURE_ROOT, 'auth')

  it('User model, users table, and pages.gen match a --verify render', async () => {
    const workspace = await createTempWorkspace('guren-parse-auth-fixture-pin-')
    try {
      await seedInertiaApp(workspace.dir)
      await makeAuth({ verify: true, force: true })

      const renderedUser = await readFile(join(workspace.dir, 'app/Models/User.ts'), 'utf8')
      const fixtureUser = await readFile(join(fixtureRoot, 'app/Models/User.ts'), 'utf8')
      expect(renderedUser).toBe(stripLeadingComments(fixtureUser))

      const renderedSchema = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      const fixtureSchema = await readFile(join(fixtureRoot, 'db/schema.ts'), 'utf8')
      for (const block of stripLeadingComments(fixtureSchema).split('\n\n')) {
        expect(renderedSchema).toContain(block)
      }

      await generatePageTypes({ appRoot: workspace.dir, extractProps: true })
      const renderedPages = await readFile(join(workspace.dir, '.guren/pages.gen.ts'), 'utf8')
      const fixturePages = await readFile(join(fixtureRoot, '.guren/pages.gen.ts'), 'utf8')
      expect(stripLeadingComments(renderedPages)).toBe(stripLeadingComments(fixturePages))
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('attachments scaffold-typecheck fixture stays pinned to the builder', () => {
  // tests/fixtures/scaffold-typecheck/attachments/db/schema.ts is a render of
  // the blueprint's Postgres schema patch, so a change to
  // ATTACHMENTS_TABLE_BLOCKS.pg has to land in the fixture too.
  it('attachments table matches what the blueprint appends to a pg schema', async () => {
    const fixtureSchema = await readFile(join(SCAFFOLD_FIXTURE_ROOT, 'attachments/db/schema.ts'), 'utf8')
    const tableStart = fixtureSchema.indexOf('export const attachments')
    expect(tableStart).toBeGreaterThan(-1)
    const fixtureTable = fixtureSchema.slice(tableStart)

    const workspace = await createTempWorkspace('guren-attachments-fixture-pin-')
    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(join(workspace.dir, 'db/schema.ts'), PG_SCHEMA_FIXTURE)
      await runBlueprint('attachments', {})

      const rendered = await readFile(join(workspace.dir, 'db/schema.ts'), 'utf8')
      // The block is appended at end of file, so the tails must be *equal*:
      // toContain would keep passing on a suffix the fixture never learned.
      const renderedStart = rendered.indexOf('export const attachments')
      expect(renderedStart).toBeGreaterThan(-1)
      expect(rendered.slice(renderedStart).trimEnd()).toBe(fixtureTable.trimEnd())

      // The shared byte-identity gate below exempts attachments, so its two
      // templates get that guarantee here instead.
      for (const path of ['config/attachments.ts', 'app/Providers/AttachmentsProvider.ts']) {
        expect(await readFile(join(workspace.dir, path), 'utf8'))
          .toBe(await readFile(join(SCAFFOLD_TEMPLATE_ROOT, 'attachments', path), 'utf8'))
      }
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('blueprint companion fixtures stay pinned to their builders', () => {
  // The companions in tests/fixtures/scaffold-typecheck/<blueprint>/ are renders
  // of the make:* builders each blueprint runs, so a builder change has to land
  // in the fixture too. Whole-file toBe, not toContain: a suffix the builder
  // grows must fail here rather than typecheck against a stale file.
  const companionPins: Array<[string, string, () => Promise<unknown>]> = [
    ['events', 'app/Events/OrderPlaced.ts', () => makeEvent('OrderPlaced', {})],
    ['events', 'app/Listeners/SendOrderReceiptListener.ts', () => makeListener('SendOrderReceipt', { event: 'OrderPlaced' })],
    ['queue', 'app/Jobs/ProcessWelcomeSequenceJob.ts', () => makeJob('ProcessWelcomeSequence', {})],
    ['broadcasting', 'app/Broadcasting/OrdersChannel.ts', () => makeChannel('Orders', { channel: 'orders' })],
    ['broadcasting', 'app/Broadcasting/UserFeedChannel.ts', () => makeChannel('UserFeed', { channel: 'users.{id}.feed', private: true })],
  ]

  for (const [blueprint, path, render] of companionPins) {
    it(`${blueprint}: ${path} matches its builder's render`, async () => {
      const fixture = await readFile(join(SCAFFOLD_FIXTURE_ROOT, blueprint, path), 'utf8')
      const workspace = await createTempWorkspace('guren-companion-pin-')
      try {
        await render()
        const rendered = await readFile(join(workspace.dir, path), 'utf8')
        expect(rendered).toBe(stripLeadingComments(fixture))
      } finally {
        await workspace.cleanup()
      }
    })
  }

  // The reverse direction: a fixture pinned by nothing drifts silently the first
  // time its builder changes. Exemptions must name fixtures that exist.
  const PINNED_ELSEWHERE: Record<string, string> = {
    'auth/': 'pinned by the auth fixture pin above, plus real codegen for pages.gen',
    'attachments/db/schema.ts': 'pinned by the attachments fixture pin above',
  }

  it('every companion fixture is pinned to a builder, or names why not', async () => {
    const fixturePaths = await relativeSourcePaths(SCAFFOLD_FIXTURE_ROOT)
    const pinned = new Set(companionPins.map(([blueprint, path]) => `${blueprint}/${path}`))

    const unpinned = fixturePaths.filter((path) =>
      !pinned.has(path) && !Object.keys(PINNED_ELSEWHERE).some((prefix) => path === prefix || path.startsWith(prefix)))
    expect(unpinned).toEqual([])

    const stale = Object.keys(PINNED_ELSEWHERE).filter((prefix) =>
      !fixturePaths.some((path) => path === prefix || path.startsWith(prefix)))
    expect(stale).toEqual([])
  })
})

describe('blueprint scaffold templates are written by their blueprints', () => {
  // Every file under templates/scaffold/<blueprint>/ must land in an app
  // byte-identical when that blueprint runs; otherwise it has drifted from the
  // tree typecheck:templates certifies. Exemptions must name dirs that exist.
  const COVERED_ELSEWHERE: Record<string, string> = {
    auth: 'flag-dependent scaffold; every template is covered by the auth reachability gate above',
    attachments: 'its run installs the storage blueprint, which this shared workspace also runs; '
      + 'its templates are byte-pinned by the attachments fixture pin above',
  }

  it('exempts only template dirs that exist', async () => {
    const dirs = new Set((await relativeSourcePaths(SCAFFOLD_TEMPLATE_ROOT)).map((path) => path.split('/')[0]))
    expect(Object.keys(COVERED_ELSEWHERE).filter((name) => !dirs.has(name))).toEqual([])
  })

  it('every shipped blueprint template lands byte-identical', async () => {
    const templatePaths = (await relativeSourcePaths(SCAFFOLD_TEMPLATE_ROOT))
      .filter((path) => !(path.split('/')[0] in COVERED_ELSEWHERE))
    expect(templatePaths.length).toBeGreaterThan(0)

    const blueprints = [...new Set(templatePaths.map((path) => path.split('/')[0]))].sort()

    const workspace = await createTempWorkspace('guren-blueprint-template-pin-')
    try {
      await seedInertiaApp(workspace.dir)
      for (const blueprint of blueprints) {
        await runBlueprint(blueprint, {})
      }
      for (const path of templatePaths) {
        const appPath = path.split('/').slice(1).join('/')
        const written = await readFile(join(workspace.dir, appPath), 'utf8')
        expect(written).toBe(await readFile(join(SCAFFOLD_TEMPLATE_ROOT, path), 'utf8'))
      }
    } finally {
      await workspace.cleanup()
    }
  })
})

