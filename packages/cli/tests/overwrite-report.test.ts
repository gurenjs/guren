import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCommand, type CommandDef } from 'citty'
import { listBlueprints, runBlueprint } from '../src/blueprints'
import { builtinSubCommands } from '../src/commands'
import { makeFeature } from '../src/make-feature'
import { APP_FIXTURE, captureSuccesses, createTempWorkspace, DEFAULT_ROUTES_FIXTURE, PG_SCHEMA_FIXTURE, seedInertiaApp, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const STALE = '// written before the --force run\n'

const CLIENT_ENTRY = `import { pageManifest } from '@/.guren/pages.gen'

void import('@guren/inertia-client').then(({ startInertiaClient }) =>
  startInertiaClient({
    pages: import.meta.glob('./pages/**/*.tsx'),
    pageManifest,
  }),
)
`

function runCli(command: keyof typeof builtinSubCommands, rawArgs: string[]): Promise<unknown> {
  return runCommand(builtinSubCommands[command] as CommandDef<never>, { rawArgs })
}

/** The one success line naming `path`: a second one means a nested writer announced it too. */
function lineFor(lines: string[], path: string): string {
  const matching = lines.filter((line) => line.endsWith(`/${path}`))
  expect(matching).toHaveLength(1)
  return matching[0]!
}

describe('--force reports the files it overwrote', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-overwrite-report-')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('make:module prints Overwrote for an existing module file and Created for the rest', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'modules/billing/index.ts': STALE })

    const lines = await captureSuccesses(() => runCli('make:module', ['billing', '--force']))

    expect(lineFor(lines, 'modules/billing/index.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'modules/billing/routes.ts')).toStartWith('Created ')
  })

  it('make:auth reports overwrites among the session files it writes through add session', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'db/schema.ts': `export const posts = 'posts'\n`,
      'routes/auth.ts': STALE,
      // Not config/session.ts: its presence reads as sessions already configured.
      'app/Providers/SessionProvider.ts': STALE,
    })

    const lines = await captureSuccesses(() => runCli('make:auth', ['--minimal', '--force']))

    expect(lineFor(lines, 'routes/auth.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Providers/SessionProvider.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'config/session.ts')).toStartWith('Created ')
  })

  it('add auth prints Overwrote for an existing auth route file', async () => {
    await seedInertiaApp(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, { 'routes/auth.ts': STALE })

    const lines = await captureSuccesses(() => runCli('add', ['auth', '--force']))

    expect(lineFor(lines, 'routes/auth.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Providers/AuthProvider.ts')).toStartWith('Created ')
  })

  it('add admin prints Overwrote for an existing admin route file', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      'routes/admin.ts': STALE,
    })

    const lines = await captureSuccesses(() => runCli('add', ['admin', '--force']))

    expect(lineFor(lines, 'routes/admin.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Http/Controllers/Admin/AdminDashboardController.ts')).toStartWith('Created ')
  })

  it('a generic add blueprint reports overwrites from both single-file generators and batch writes', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'src/app.ts': APP_FIXTURE,
      'app/Events/OrderPlaced.ts': STALE,
      'app/Providers/EventProvider.ts': STALE,
    })

    const lines = await captureSuccesses(() => runCli('add', ['events', '--force']))

    expect(lineFor(lines, 'app/Events/OrderPlaced.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Providers/EventProvider.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Listeners/SendOrderReceiptListener.ts')).toStartWith('Created ')
  })

  it('add resource announces each file once, overwritten ones as Overwrote', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'resources/js/pages/.keep': '',
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      'db/schema.ts': PG_SCHEMA_FIXTURE,
      'app/Models/Post.ts': STALE,
      'app/Http/Controllers/PostController.ts': STALE,
    })

    const lines = await captureSuccesses(() => runCli('add', ['resource', 'Post', '--force']))

    expect(lineFor(lines, 'app/Models/Post.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Http/Controllers/PostController.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Http/Resources/PostResource.ts')).toStartWith('Created ')
    expect(lineFor(lines, 'resources/js/pages/posts/Index.tsx')).toStartWith('Created ')
  })

  it('make:feature prints Overwrote for an existing model and controller', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      'app/Models/Post.ts': STALE,
      'app/Http/Controllers/PostController.ts': STALE,
    })

    const lines = await captureSuccesses(() => runCli('make:feature', ['Post', '--force']))

    expect(lineFor(lines, 'app/Models/Post.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Http/Controllers/PostController.ts')).toStartWith('Overwrote ')
    expect(lineFor(lines, 'app/Http/Validators/PostValidator.ts')).toStartWith('Created ')
  })

  it('makeFeature with announce: false stays silent and still fills the caller\'s report', async () => {
    await writeWorkspaceFiles(workspace.dir, {
      'routes/web.ts': DEFAULT_ROUTES_FIXTURE,
      'app/Models/Post.ts': STALE,
      // Present, so ensureGurenUiTokens stays quiet: it announces its own write.
      'resources/css/guren.css': '',
    })
    const overwritten: string[] = []

    const lines = await captureSuccesses(() => makeFeature('Post', { force: true, announce: false, overwritten }))

    expect(lines).toEqual([])
    expect(overwritten).toHaveLength(1)
    expect(overwritten[0]).toEndWith('/app/Models/Post.ts')
  })
})

// `auth` and `resource` are exercised through their commands above: auth's
// install step generates a migration, and resource needs a name and a schema.
const THREADED_BLUEPRINTS = listBlueprints().filter((name) => name !== 'auth' && name !== 'resource')

describe('every blueprint carries the overwrite report to its writers', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-overwrite-blueprints-')
    await seedInertiaApp(workspace.dir)
    await writeWorkspaceFiles(workspace.dir, {
      'resources/js/app.tsx': CLIENT_ENTRY,
      'package.json': `${JSON.stringify({ name: 'app', scripts: { dev: 'bun run dev:server', build: 'bunx vite build' } }, null, 2)}\n`,
    })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  for (const name of THREADED_BLUEPRINTS) {
    it(`${name} names every file a second --force run replaced`, async () => {
      const first: string[] = []
      const created = await runBlueprint(name, { overwritten: first })
      expect(created.length).toBeGreaterThan(0)
      expect(first).toEqual([])

      const second: string[] = []
      const rewritten = await runBlueprint(name, { force: true, overwritten: second })

      expect(rewritten.length).toBeGreaterThan(0)
      expect([...second].sort()).toEqual([...rewritten].sort())
    })
  }
})
