import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { FIELD_TYPES } from '../../packages/cli/src/fields'
import { DATABASE_DRIVERS } from '../../packages/create-app/src/blueprints'
import { fileExists } from '../../packages/create-app/src/utils'
import { auditBlueprintTemplates, auditConsoleWiring, auditStarterTemplate } from './starter-template-audit'
import {
  collectLocalPackages,
  declaredDependencies,
  ensureBuiltPackages,
  isLocalSpecifier,
  rewriteAppDependencies,
  vendorLocalPackages,
  type DependencyManifest,
} from './local-packages'

interface PublishedArtifact {
  name: string
  sourceDir: string
}

// `vendored` and `packed` install builds of this checkout; `npm` keeps the
// template's own ranges, so it is the only mode that sees templates drift
// ahead of the published packages.
const INSTALL_MODES = ['vendored', 'packed', 'npm'] as const
type InstallMode = (typeof INSTALL_MODES)[number]

const repoRoot = resolve(import.meta.dir, '../..')

/**
 * The `--fields` the resource blueprint is scaffolded with, derived from
 * `FIELD_TYPES`: this is the only gate that *compiles* the per-type code the
 * resource builders emit, and a hand-written list would keep claiming full
 * coverage after a new type is added. Nullable and non-nullable per type,
 * since those render differently.
 */
const RESOURCE_FIELDS = FIELD_TYPES.flatMap((type) => [
  `${type}Field:${type}`,
  `nullable${type[0].toUpperCase()}${type.slice(1)}Field:${type}?`,
]).join(',')

// The feature blueprints a default-blueprint app gets, in scaffolder order.
// It cannot be derived from the CLI's registry (`resource` needs a name, `mail`
// a flag), so assertCoversEveryBlueprint() checks it against that registry.
// admin and oauth follow auth for its sign-in page; `--force` on mail
// supersedes the MailProvider auth wrote.
const DEFAULT_BLUEPRINT_FEATURES: readonly (readonly string[])[] = [
  ['auth'],
  ['admin'],
  ['oauth'],
  ['resource', 'posts', '--fields', RESOURCE_FIELDS],
  ['queue'],
  ['mail', '--force'],
  ['events'],
  ['cache'],
  ['notifications'],
  ['storage'],
  // After storage, so attachments exercises its own scaffolds rather than
  // re-running the storage prerequisite.
  ['attachments'],
  // After attachments: `--attach` refuses an app without configureAttachments().
  // The one gate that typechecks the attach-aware model and controller.
  ['resource', 'photos', '--fields', 'title:string,caption:text?', '--attach', 'cover:one,images:many'],
  ['broadcasting'],
  ['schedule'],
]

/**
 * Fail when the CLI grows a blueprint this smoke does not scaffold (the pointer
 * back from packages/cli/tests/blueprints.test.ts). Imported dynamically because
 * packages/cli/src/blueprints reaches @guren/server through untracked dist/: a
 * top-level import evaluates before ensureBuiltPackages(), turning a missing
 * build into a resolution error instead of the message that names the fix.
 */
async function assertCoversEveryBlueprint(): Promise<void> {
  const { listBlueprints } = await import('../../packages/cli/src/blueprints')
  const covered = new Set(DEFAULT_BLUEPRINT_FEATURES.map(([name]) => name))
  const missing = listBlueprints().filter((name) => !covered.has(name))
  assert(
    missing.length === 0,
    `The default blueprint smoke does not scaffold: ${missing.join(', ')}. ` +
      'Add them to DEFAULT_BLUEPRINT_FEATURES — a blueprint no smoke scaffolds ' +
      'is template code no gate typechecks against the published packages.',
  )
}

/**
 * Run the feature blueprints through *this checkout's* CLI. In npm mode this is
 * what lets the gate fail: the app's installed `guren` ships published blueprints
 * and would emit published templates against published packages. Templates from
 * here, dependencies from the registry, is the mismatch the drift check measures.
 */
async function addDefaultBlueprintFeatures(
  appDir: string,
  runtimeEnv: Record<string, string>,
): Promise<void> {
  for (const feature of DEFAULT_BLUEPRINT_FEATURES) {
    await run(
      ['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', ...feature],
      appDir,
      // The CLI runs from source while the app resolves @guren/orm from its own
      // node_modules, so two copies legitimately coexist here. Scoped to these
      // calls so a genuine duplicate in the app stays loud.
      { ...runtimeEnv, GUREN_QUIET_DUPLICATE_ORM: '1' },
    )
  }
}

async function run(cmd: string[], cwd: string, envOverrides?: Record<string, string>): Promise<void> {
  console.log(`\n$ (${cwd}) ${cmd.join(' ')}`)
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...envOverrides,
    },
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(' ')}`)
  }
}

async function runCapture(cmd: string[], cwd: string, envOverrides?: Record<string, string>): Promise<string> {
  console.log(`\n$ (${cwd}) ${cmd.join(' ')}`)
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: 'pipe',
    stderr: 'inherit',
    env: {
      ...process.env,
      ...envOverrides,
    },
  })
  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    // `tsc` writes every error to stdout, so a failure has to hand the piped
    // output back or the log shows only the exit code.
    console.error(output)
    throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(' ')}`)
  }
  return output
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function tarballFileName(pkg: PublishedArtifact): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(pkg.sourceDir, 'package.json'), 'utf8')) as {
    version: string
  }
  return `${pkg.name.replace('@', '').replace('/', '-')}-${packageJson.version}.tgz`
}

async function packPackages(packRoot: string): Promise<Map<string, string>> {
  await mkdir(packRoot, { recursive: true })
  const npmCacheDir = join(packRoot, '.npm-cache')
  await mkdir(npmCacheDir, { recursive: true })
  const tarballs = new Map<string, string>()

  // What a scaffolded app installs: the vendored set plus the scaffolder that
  // produced it. `@guren/openapi` and the deploy plugins are opt-in, so packing
  // them here would audit tarballs this smoke never installs.
  const publishedArtifacts: PublishedArtifact[] = [
    ...await collectLocalPackages(),
    { name: 'create-guren-app', sourceDir: resolve(repoRoot, 'packages/create-app') },
  ]

  for (const pkg of publishedArtifacts) {
    await runCapture(
      ['npm', 'pack', '--pack-destination', packRoot],
      pkg.sourceDir,
      { NPM_CONFIG_CACHE: npmCacheDir },
    )
    tarballs.set(pkg.name, join(packRoot, await tarballFileName(pkg)))
  }

  return tarballs
}

async function listTarballEntries(tarballPath: string): Promise<string[]> {
  const output = await runCapture(['tar', '-tf', tarballPath], repoRoot)
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function extractTarball(tarballPath: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true })
  await runCapture(['tar', '-xf', tarballPath, '-C', destinationDir], repoRoot)
}

async function collectFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const entryPath = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(entryPath))
      continue
    }
    if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

async function assertPackedArtifacts(packageTarballs: Map<string, string>, packRoot: string): Promise<void> {
  for (const [packageName, tarballPath] of packageTarballs) {
    const entries = await listTarballEntries(tarballPath)
    assert(entries.includes('package/package.json'), `${packageName} tarball is missing package/package.json`)
    assert(entries.some((entry) => entry.startsWith('package/dist/')), `${packageName} tarball is missing dist assets`)

    if (packageName === '@guren/core') {
      assert(entries.includes('package/dist/runtime.js'), '@guren/core tarball is missing dist/runtime.js')
      assert(entries.includes('package/dist/vite.js'), '@guren/core tarball is missing dist/vite.js')
    }

    if (packageName === '@guren/cli' || packageName === 'create-guren-app') {
      const extractDir = join(packRoot, '.extracted', packageName.replace('/', '-').replace('@', ''))
      await extractTarball(tarballPath, extractDir)

      if (packageName === '@guren/cli') {
        const distFiles = (await collectFiles(join(extractDir, 'package/dist'))).filter((file) => file.endsWith('.js'))
        const distContents = (await Promise.all(distFiles.map((file) => readFile(file, 'utf8')))).join('\n')
        assert(distContents.includes('defineGeneratedPage'), '@guren/cli tarball is missing the generated page helper implementation.')
        assert(distContents.includes('PaginatedPageProps'), '@guren/cli tarball is missing paginated resource scaffold support.')
        assert(!distContents.includes("import { definePage } from '@guren/inertia-client'"), '@guren/cli tarball still emits definePage() runtime imports for generated pages.')
      }

      if (packageName === 'create-guren-app') {
        for (const template of ['default', 'api-only']) {
          assert(
            entries.includes(`package/templates/${template}/_gitignore`),
            `create-guren-app tarball is missing templates/${template}/_gitignore — npm strips files named .gitignore, so scaffolded apps would ship without one`,
          )
        }

        await auditStarterTemplate(join(extractDir, 'package/templates/default'))
        await auditConsoleWiring(join(extractDir, 'package/templates/api-only'))
        await auditBlueprintTemplates(join(extractDir, 'package'))
      }
    }
  }
}

async function assertCoreFirstStarter(
  appDir: string,
  options: { checkDependencies?: boolean } = {},
): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }

  if (options.checkDependencies !== false && packageJson.dependencies?.['@guren/server']) {
    throw new Error('Fresh app unexpectedly depends on @guren/server directly.')
  }

  const filesToCheck = [
    'src/app.ts',
    'src/main.ts',
    'vite.config.ts',
    'routes/web.ts',
    'routes/api.ts',
    'resources/js/pages/Home.tsx',
  ]

  for (const relativePath of filesToCheck) {
    let source: string
    try {
      source = await readFile(join(appDir, relativePath), 'utf8')
    } catch {
      continue
    }
    if (source.includes('@guren/server')) {
      throw new Error(`Fresh app contains a stale @guren/server import in ${relativePath}.`)
    }
  }
}

async function assertCanonicalScaffolds(appDir: string): Promise<void> {
  const loginController = await readFile(join(appDir, 'app/Http/Controllers/Auth/LoginController.ts'), 'utf8')
  assert(loginController.includes('await this.validateBody('), 'Auth scaffold must use validateBody() in LoginController.')
  assert(!loginController.includes('.safeParse('), 'Auth scaffold must not use manual safeParse() in LoginController.')
  assert(!loginController.includes('getEventManager'), 'Auth scaffold must not use event helper singletons in LoginController.')

  const postController = await readFile(join(appDir, 'app/Http/Controllers/PostController.ts'), 'utf8')
  assert(postController.includes('type PostsIndexProps = PaginatedPageProps<PostResourceData>'), 'Resource scaffold must use PaginatedPageProps in index controller.')
  assert(postController.includes('await this.auth.userOrFail()'), 'Resource scaffold must require auth in mutating actions by default.')
  assert(postController.includes('const paginator = paginate(result,'), 'Resource scaffold must use paginate(result, ...) as the canonical paginator path.')
  assert(!postController.includes('.safeParse('), 'Resource scaffold must not use manual safeParse() in PostController.')
  assert(!postController.includes('getEventManager'), 'Resource scaffold must not use event helper singletons in PostController.')

  const postResource = await readFile(join(appDir, 'app/Http/Resources/PostResource.ts'), 'utf8')
  assert(postResource.includes('toArray(): PostResourceData'), 'Resource scaffold must define an explicit toArray() output type.')

  const loginPage = await readFile(join(appDir, 'resources/js/pages/auth/Login.tsx'), 'utf8')
  assert(loginPage.includes('interface Props'), 'Auth login page must define Props interface.')

  const postsIndexPage = await readFile(join(appDir, 'resources/js/pages/posts/Index.tsx'), 'utf8')
  assert(postsIndexPage.includes('interface Props') || postsIndexPage.includes('PaginatedPageProps'), 'Posts index page must define Props.')

  const layout = await readFile(join(appDir, 'resources/js/components/Layout.tsx'), 'utf8')
  assert(!layout.includes('action="/logout"'), 'Auth layout must not log out through a native form POST — CSRF rejects it.')
  assert(layout.includes('href="/logout"'), 'Auth layout must log out through an Inertia Link.')
  assert(layout.includes('method="post"'), 'Auth layout logout Link must POST — the default GET does not match the route.')
  assert(layout.includes('as="button"'), 'Auth layout logout Link must render as a button.')
}

/**
 * The blog template ships its app code instead of generating it, so nothing
 * else in CI reads these files. These assert the wiring that compiles either
 * way: an unregistered policy, a mass-assignable `authorId`, or a leftover
 * per-driver schema variant all typecheck fine and all break the app.
 */
async function assertBlogScaffold(appDir: string): Promise<void> {
  for (const driver of DATABASE_DRIVERS) {
    assert(
      !await fileExists(join(appDir, `db/schema.${driver}.ts`)),
      `Blog blueprint left db/schema.${driver}.ts behind in the scaffolded app.`,
    )
  }

  const schema = await readFile(join(appDir, 'db/schema.ts'), 'utf8')
  assert(schema.includes('export const posts'), 'Blog blueprint must ship a posts table.')
  assert(schema.includes('author_id'), 'Blog posts must carry their author.')

  const appBootstrap = await readFile(join(appDir, 'src/app.ts'), 'utf8')
  assert(appBootstrap.includes('AuthProvider'), 'Blog blueprint must register AuthProvider.')
  assert(appBootstrap.includes('AuthorizationProvider'), 'Blog blueprint must register AuthorizationProvider.')

  // getGate() throws until the framework's own provider has registered, so the
  // policy has to be bound from a provider's boot(), not at module scope.
  const authorizationProvider = await readFile(join(appDir, 'app/Providers/AuthorizationProvider.ts'), 'utf8')
  assert(
    /boot\(\)[^{]*\{[^}]*getGate\(\)\.policy\(Post,\s*PostPolicy\)/su.test(authorizationProvider),
    'Blog blueprint must bind PostPolicy to the Post model from boot(), not at module scope.',
  )

  // Layout.tsx gates every authenticated control on the shared user, so
  // without this the nav renders as a guest and Log out is unreachable.
  const authProvider = await readFile(join(appDir, 'app/Providers/AuthProvider.ts'), 'utf8')
  assert(authProvider.includes('shareInertiaProps('), 'Blog blueprint must share the signed-in user with Inertia.')

  // A native form POST carries neither the X-XSRF-TOKEN header nor a _token
  // field, so the click silently does nothing.
  const layout = await readFile(join(appDir, 'resources/js/components/Layout.tsx'), 'utf8')
  assert(!/<form[^>]*method="post"/iu.test(layout), 'Blog blueprint must not post from a native form — CSRF rejects it.')
  assert(/<Link[^>]*method="post"/su.test(layout), 'Blog blueprint must log out through an Inertia Link.')

  const post = await readFile(join(appDir, 'app/Models/Post.ts'), 'utf8')
  assert(post.includes('static fillable'), 'Blog Post model must declare fillable fields.')
  assert(!/fillable\s*=\s*\[[^\]]*authorId/su.test(post), 'Blog Post model must not accept authorId as mass-assignable input.')

  const postController = await readFile(join(appDir, 'app/Http/Controllers/PostController.ts'), 'utf8')
  for (const ability of ["'create'", "'update'", "'delete'"]) {
    assert(postController.includes(`this.authorize(${ability}`), `Blog PostController must authorize ${ability}.`)
  }
  assert(postController.includes('authorId: author.id'), 'Blog PostController must set the author from the signed-in user.')

  const webRoutes = await readFile(join(appDir, 'routes/web.ts'), 'utf8')
  assert(webRoutes.includes('registerAuthRoutes(router)'), 'Blog blueprint must register its auth routes.')
  // Named, because `guren audit` cannot inspect a middleware passed inline as a
  // call result and downgrades those routes to an unverifiable warning.
  assert(webRoutes.includes("aliasMiddleware('auth'"), 'Blog blueprint must alias its auth middleware.')
  assert(webRoutes.includes("posts.middleware('auth').group("), 'Blog blueprint must guard mutating post routes with the named auth middleware.')

  // Nothing else in CI loads the seeders.
  for (const seeder of ['db/seeders/001_users.ts', 'db/seeders/002_posts.ts']) {
    const source = await readFile(join(appDir, seeder), 'utf8')
    assert(source.includes('defineSeeder'), `${seeder} must export a seeder.`)
    assert(!source.includes('onConflictDoNothing'), `${seeder} must stay portable across the drivers this blueprint supports.`)
  }
}

async function assertFeatureScaffolds(appDir: string): Promise<void> {
  const appBootstrap = await readFile(join(appDir, 'src/app.ts'), 'utf8')
  for (const providerName of [
    'CoreCacheServiceProvider',
    'CacheProvider',
    'CoreEventServiceProvider',
    'EventProvider',
    'CoreMailServiceProvider',
    'MailProvider',
    'CoreNotificationServiceProvider',
    'NotificationProvider',
    'CoreQueueServiceProvider',
    'QueueProvider',
    'CoreSchedulingServiceProvider',
    'CoreStorageServiceProvider',
    'StorageProvider',
    'CoreBroadcastServiceProvider',
    'BroadcastProvider',
  ]) {
    assert(appBootstrap.includes(providerName), `Fresh app must register ${providerName} in src/app.ts after feature scaffolds.`)
  }

  const cacheProvider = await readFile(join(appDir, 'app/Providers/CacheProvider.ts'), 'utf8')
  assert(cacheProvider.includes("from '@guren/core'"), 'Cache blueprint must import from @guren/core.')
  assert(cacheProvider.includes('createCacheManager'), 'Cache blueprint must create a cache manager.')
  assert(cacheProvider.includes("this.container.singleton('cache'"), 'Cache blueprint must register cache in the container.')
  assert(!cacheProvider.includes('@guren/server'), 'Cache blueprint must not import from @guren/server.')

  const eventProvider = await readFile(join(appDir, 'app/Providers/EventProvider.ts'), 'utf8')
  assert(eventProvider.includes("from '@guren/core'"), 'Events blueprint must import from @guren/core.')
  assert(eventProvider.includes("this.container.make<EventManager>('events')"), 'Events blueprint must resolve the event manager from the container.')
  assert(eventProvider.includes('events.on(OrderPlaced'), 'Events blueprint must register listeners through the event manager.')
  assert(!eventProvider.includes('@guren/server'), 'Events blueprint must not import from @guren/server.')

  const mailProvider = await readFile(join(appDir, 'app/Providers/MailProvider.ts'), 'utf8')
  assert(mailProvider.includes("from '@guren/core'"), 'Mail blueprint must import from @guren/core.')
  assert(mailProvider.includes('createMailManager'), 'Mail blueprint must create a mail manager.')
  assert(mailProvider.includes("this.container.instance('mail', manager)"), 'Mail blueprint must bind the mail manager into the container.')
  assert(mailProvider.includes('setMailManager(manager)'), 'Mail blueprint must connect the mail manager to the runtime mail facade.')
  assert(!mailProvider.includes('@guren/server'), 'Mail blueprint must not import from @guren/server.')

  const welcomeMail = await readFile(join(appDir, 'app/Mail/WelcomeEmailMail.ts'), 'utf8')
  assert(welcomeMail.includes('manager: MailManager'), 'Mail scaffold must require explicit MailManager injection.')
  assert(!welcomeMail.includes('getMailManager()'), 'Mail scaffold must not use the global mail manager helper.')

  const queueProvider = await readFile(join(appDir, 'app/Providers/QueueProvider.ts'), 'utf8')
  assert(queueProvider.includes("from '@guren/core'"), 'Queue blueprint must import from @guren/core.')
  assert(queueProvider.includes('createQueueManager'), 'Queue blueprint must create a queue manager.')
  assert(queueProvider.includes("this.container.instance('queue', queue)"), 'Queue blueprint must bind the queue manager into the container.')
  assert(queueProvider.includes('registerJob(ProcessWelcomeSequenceJob)'), 'Queue blueprint must register its sample job.')
  assert(!queueProvider.includes('@guren/server'), 'Queue blueprint must not import from @guren/server.')

  const notificationProvider = await readFile(join(appDir, 'app/Providers/NotificationProvider.ts'), 'utf8')
  assert(notificationProvider.includes("from '@guren/core'"), 'Notification blueprint must import from @guren/core.')
  assert(notificationProvider.includes("this.container.make<NotificationManager>('notifications')"), 'Notification blueprint must resolve notifications from the container.')
  assert(notificationProvider.includes('new MailChannel(mail)'), 'Notification blueprint must wire the mail channel through the container mail manager.')
  assert(notificationProvider.includes('new DatabaseChannel()'), 'Notification blueprint must wire the database channel.')

  const storageProvider = await readFile(join(appDir, 'app/Providers/StorageProvider.ts'), 'utf8')
  assert(storageProvider.includes("from '@guren/core'"), 'Storage blueprint must import from @guren/core.')
  assert(storageProvider.includes('createStorageManager'), 'Storage blueprint must create a storage manager.')
  assert(storageProvider.includes("this.container.instance('storage'"), 'Storage blueprint must bind storage into the container.')
  assert(
    storageProvider.includes("public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' }"),
    "Storage blueprint must expose a public disk that declares itself public and carries a served URL — a local disk has no per-object visibility (an undeclared 'public' disk reports 'private' and refuses put({ visibility: 'public' })), and without url + a root inside public/ every disk.url() points at nothing the app serves.",
  )
  assert(storageProvider.includes('STORAGE_DISK'), 'Storage blueprint must select its disk from STORAGE_DISK.')

  const broadcastProvider = await readFile(join(appDir, 'app/Providers/BroadcastProvider.ts'), 'utf8')
  assert(broadcastProvider.includes("from '@guren/core'"), 'Broadcasting blueprint must import from @guren/core.')
  assert(broadcastProvider.includes('createBroadcastManager'), 'Broadcasting blueprint must create a broadcast manager.')
  assert(broadcastProvider.includes("this.container.instance('broadcast'"), 'Broadcasting blueprint must bind broadcast into the container.')
  assert(broadcastProvider.includes('broadcast.channel(orders.getChannelName()'), 'Broadcasting blueprint must register a public channel.')
  assert(broadcastProvider.includes('broadcast.privateChannel(userFeed.getBaseName()'), 'Broadcasting blueprint must register a private channel.')

  const scheduleKernel = await readFile(join(appDir, 'app/Console/Kernel.ts'), 'utf8')
  assert(scheduleKernel.includes("import { Schedule } from '@guren/core'"), 'Schedule blueprint must import Schedule from @guren/core.')
  assert(scheduleKernel.includes("name('app-heartbeat')"), 'Schedule blueprint must register the sample heartbeat task.')
}

/**
 * Install the scaffolded app from the registry, scaffold its features with this
 * checkout's CLI, and typecheck the result. Resolving the template's own ranges is
 * the point: this fails whenever a template uses an API that exists only in this
 * repository, which the other install modes and the root `typecheck` (it excludes
 * `templates`) cannot see. No build, test, check or audit: the vendored mode owns them.
 */
async function runPublishedDependencyDrift(
  appDir: string,
  blueprint: string,
  runtimeEnv: Record<string, string>,
): Promise<void> {
  // If this mode ever degraded into a vendored one it would keep passing while
  // checking nothing, so local specifiers are asserted away rather than assumed
  // absent — re-run after scaffolding, since a blueprint may add a dependency.
  const assertPublishedRanges = async (stage: string): Promise<[string, string][]> => {
    const packageJson = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as DependencyManifest
    const gurenDependencies = Object.entries(declaredDependencies(packageJson))
      .filter(([name]) => name.startsWith('@guren/'))

    assert(
      gurenDependencies.length > 0,
      `Scaffolded app declares no @guren/* dependencies to resolve from npm (${stage}).`,
    )
    for (const [name, range] of gurenDependencies) {
      assert(
        !isLocalSpecifier(range),
        `npm install mode requires ${name} to keep its published range, got "${range}" (${stage}).`,
      )
    }
    return gurenDependencies
  }

  await assertPublishedRanges('as scaffolded')

  // The scaffolder already installed, but it only warns on failure — this is
  // the install whose exit code can fail the job.
  await run(['bun', 'install'], appDir, runtimeEnv)

  const gurenDependencies = await assertPublishedRanges('after install')
  const resolved: string[] = []
  for (const [name, range] of gurenDependencies) {
    const installed = JSON.parse(
      await readFile(join(appDir, 'node_modules', name, 'package.json'), 'utf8'),
    ) as { version: string }
    resolved.push(`${name}@${installed.version} (declared ${range})`)
  }
  console.log(`\nResolved from npm:\n  ${resolved.join('\n  ')}`)

  const scaffoldsFeatures = blueprint === 'default'
  if (scaffoldsFeatures) {
    await addDefaultBlueprintFeatures(appDir, runtimeEnv)
    await assertPublishedRanges('after scaffolding features')
    await run(['bun', 'install'], appDir, runtimeEnv)
    // These keep the typecheck below from quietly shrinking back to a bare app.
    await assertCanonicalScaffolds(appDir)
    await assertFeatureScaffolds(appDir)
  }

  // Skipped for blog for the reason spelled out in its vendored branch below.
  const runsCodegen = blueprint !== 'blog'

  let checkedFiles: string[]
  try {
    if (runsCodegen) {
      await run(['bun', 'run', 'codegen'], appDir, runtimeEnv)
    }
    checkedFiles = await typecheckApp(appDir, runtimeEnv)
  } catch (error) {
    console.error('\nThe scaffolded app does not build against the published packages listed above.')
    throw error
  }

  console.log([
    '',
    `Published dependency drift check passed (${blueprint}): ${appDir}`,
    'What this run covered:',
    `  blueprint            ${blueprint}`,
    `  feature blueprints   ${scaffoldsFeatures
      ? DEFAULT_BLUEPRINT_FEATURES.map((feature) => feature[0]).join(', ')
      : `none — the ${blueprint} blueprint ships its own and adds no features`}`,
    `  codegen              ${runsCodegen ? 'ran' : 'skipped — blog typechecks the .guren stubs it ships'}`,
    `  typechecked          ${checkedFiles.length} app files (tsc --noEmit)`,
    '  not covered          bun run build, bun test, guren check, guren audit — the vendored smoke owns those',
  ].join('\n'))
}

/**
 * Typecheck the app through its own `typecheck` script, and assert tsc actually
 * read the files it was supposed to. `"include": [".guren"]` matches no files:
 * TypeScript expands a bare directory to a wildcard whose matcher skips
 * dot-prefixed segments. Imported files still arrive through the import graph,
 * so the ones nothing imports are the tell (`--listFiles`).
 */
async function typecheckApp(appDir: string, runtimeEnv: Record<string, string>): Promise<string[]> {
  const output = await runCapture(['bun', 'run', 'typecheck', '--listFiles'], appDir, runtimeEnv)

  // tsc reports realpaths, and macOS hands out a /var -> /private/var symlink
  // for the temp dir, so compare against the resolved prefix.
  const appRoot = await realpath(appDir)
  const checkedFiles = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${appRoot}/`) && !line.includes('/node_modules/'))
    .map((line) => line.slice(appRoot.length + 1))
  assert(
    checkedFiles.length > 0,
    "tsc read none of the app's own files — the scaffolded tsconfig covers nothing.",
  )

  const generated = (await readdir(join(appDir, '.guren')).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.gen.ts'))
  const unchecked = generated.filter((name) => !checkedFiles.includes(join('.guren', name)))
  assert(
    unchecked.length === 0,
    `tsc never read ${unchecked.map((name) => `.guren/${name}`).join(', ')} — ` +
      "the app's tsconfig does not cover its own generated files. A bare " +
      '".guren" include entry is the usual cause; it needs an explicit glob.',
  )

  return checkedFiles
}

function resolveInstallMode(): InstallMode {
  const requested = process.env.GUREN_SMOKE_INSTALL_MODE
  if (!requested) {
    return 'vendored'
  }
  if (!INSTALL_MODES.includes(requested as InstallMode)) {
    throw new Error(`Unknown GUREN_SMOKE_INSTALL_MODE "${requested}". Supported values: ${INSTALL_MODES.join(', ')}.`)
  }
  return requested as InstallMode
}

async function main(): Promise<void> {
  const installMode = resolveInstallMode()

  // Every mode needs the workspace built: npm mode keeps the *app* off this
  // checkout, but the scaffolder emitting the templates under test runs from
  // here and reaches @guren/server through dist/.
  await ensureBuiltPackages()
  await assertCoversEveryBlueprint()

  const blueprint = process.env.GUREN_SMOKE_BLUEPRINT ?? 'default'
  const tempRoot = await mkdtemp(join(tmpdir(), `guren-fresh-app-${blueprint}-`))
  const appDir = join(tempRoot, 'app')
  const runtimeTempDir = join(tempRoot, '.tmp')
  const bunInstallCacheDir = join(tempRoot, '.bun-install-cache')
  const keepTemp = process.env.GUREN_KEEP_SMOKE_DIR === '1'
  const runtimeEnv = {
    TMPDIR: runtimeTempDir,
    BUN_INSTALL_CACHE_DIR: bunInstallCacheDir,
  }

  try {
    await mkdir(runtimeTempDir, { recursive: true })
    await mkdir(bunInstallCacheDir, { recursive: true })

    const createArgs = ['bun', resolve(repoRoot, 'packages/create-app/src/cli.ts'), appDir]
    if (blueprint !== 'default') {
      createArgs.push('--blueprint', blueprint)
    }
    // All blueprints require a mode flag to avoid interactive prompt
    createArgs.push('--mode', blueprint === 'api' ? 'spa' : 'ssr')
    await run(createArgs, repoRoot, runtimeEnv)

    await assertCoreFirstStarter(appDir)

    if (installMode === 'npm') {
      await runPublishedDependencyDrift(appDir, blueprint, runtimeEnv)
      return
    }

    const vendorDir = join(appDir, '.guren-vendor')
    const packDir = join(appDir, '.guren-packed')
    const dependencyRoots = installMode === 'packed'
      ? await packPackages(packDir)
      : await vendorLocalPackages(vendorDir)
    if (installMode === 'packed') {
      await assertPackedArtifacts(dependencyRoots, packDir)
    }
    await rewriteAppDependencies(appDir, dependencyRoots, `The ${installMode} app`)
    if (installMode === 'packed') {
      // A tarball dependency is the one claim only this mode can make, and
      // the only thing that catches it degrading into the vendored one.
      const declared = declaredDependencies(
        JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as DependencyManifest,
      )
      for (const pkg of await collectLocalPackages()) {
        const dependencyValue = declared[pkg.name]
        assert(
          typeof dependencyValue === 'string' && dependencyValue.endsWith('.tgz'),
          `Fresh app did not rewrite ${pkg.name} to a local tarball dependency.`,
        )
      }
      console.log(`\nPacked artifact audit passed (${blueprint}): ${appDir}`)
      return
    }

    await run(['bun', 'install'], appDir, runtimeEnv)

    if (blueprint === 'default') {
      await addDefaultBlueprintFeatures(appDir, runtimeEnv)
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
      await assertCanonicalScaffolds(appDir)
      await assertFeatureScaffolds(appDir)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--routes', 'routes/web.ts', '--out', 'types/generated/routes.d.ts', '--force'], appDir, runtimeEnv)
    } else if (blueprint === 'api') {
      const routesFile = await readFile(join(appDir, 'routes/api.ts'), 'utf8')
      assert(routesFile.includes('/health'), 'API blueprint must include a /health endpoint.')
      assert(routesFile.includes('/api/v1'), 'API blueprint must include /api/v1 prefix.')
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
    } else if (blueprint === 'blog') {
      // No codegen before the typecheck below: regenerating the .guren/*.gen.ts
      // the template ships would hide stubs that have fallen behind it.
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
      await assertBlogScaffold(appDir)
    } else if (blueprint === 'worker') {
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
      const appTs = await readFile(join(appDir, 'src/app.ts'), 'utf8')
      assert(appTs.includes('QueueServiceProvider'), 'Worker blueprint must scaffold queue.')
      assert(appTs.includes('EventServiceProvider'), 'Worker blueprint must scaffold events.')
      assert(appTs.includes('CacheServiceProvider'), 'Worker blueprint must scaffold cache.')
      assert(appTs.includes('SchedulingServiceProvider'), 'Worker blueprint must scaffold schedule.')
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--routes', 'routes/web.ts', '--out', 'types/generated/routes.d.ts', '--force'], appDir, runtimeEnv)
    }

    await typecheckApp(appDir, runtimeEnv)

    await run(['bun', 'run', 'build'], appDir, runtimeEnv)

    // API blueprint has no Vite build output — skip bundle budget
    if (blueprint !== 'api') {
      await run(['bun', resolve(repoRoot, 'scripts/smoke/build-budget.ts'), '--max-kb', '600', appDir], repoRoot, runtimeEnv)
    }

    // Templates advertise a starter test suite and a CI workflow gating on
    // `check --ci` and `guren audit`; exercise all three so they cannot drift
    // from the framework. The api blueprint needs its codegen manifests first.
    // --no-deps keeps the audit off the network; older CLI releases ignore it.
    if (blueprint === 'api') {
      await run(['bun', 'run', 'codegen'], appDir, runtimeEnv)
    }
    const routesArgs = blueprint === 'api' ? ['--routes', 'routes/api.ts'] : []
    await run(['bun', 'test'], appDir, runtimeEnv)
    await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'check', '--ci', ...routesArgs], appDir, runtimeEnv)
    await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'audit', '--no-deps', ...routesArgs], appDir, runtimeEnv)

    // `guren add lint` wires oxlint with the @guren/cli/oxlint plugin. A fresh app has
    // to lint clean under that preset, or the first `bun run lint` a user sees is red.
    await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'lint'], appDir, runtimeEnv)
    await run(['bun', 'install'], appDir, runtimeEnv)
    await run(['bun', 'run', 'lint'], appDir, runtimeEnv)

    console.log(`\nFresh app smoke passed (${blueprint}, ${installMode}): ${appDir}`)
  } finally {
    if (keepTemp) {
      console.log(`\nKeeping smoke workspace: ${tempRoot}`)
    } else {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }
}

await main()
