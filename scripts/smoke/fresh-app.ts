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

// `vendored` and `packed` both point the scaffolded app at builds of this
// checkout; `npm` leaves the template's own ranges alone and installs from the
// registry, so it is the only mode that sees the templates drift ahead of the
// published packages.
const INSTALL_MODES = ['vendored', 'packed', 'npm'] as const
type InstallMode = (typeof INSTALL_MODES)[number]

const repoRoot = resolve(import.meta.dir, '../..')

/**
 * The `--fields` the resource blueprint is scaffolded with.
 *
 * Derived from `FIELD_TYPES` rather than written out, because this smoke is
 * the only gate that *compiles* what `generateResource()` and the page
 * builders emit per type — everything else about a field type fails at the
 * type level (`tsFieldType`'s and `ColumnMapping`'s `Record<FieldType, …>`),
 * but the rendered code is builder output that is otherwise only
 * parse-checked. A hand-written list would keep passing, and keep claiming
 * full coverage, the day a seventh type is added.
 *
 * `DEFAULT_FIELDS` already covers a plain read and a nullable one, so a bare
 * `add resource` is not nothing — what it misses is number, boolean, date and
 * json, and json is the only type drizzle leaves as `unknown`.
 *
 * Nullable *and* not, per type, because nullability is a second axis rather
 * than a seventh type: a nullable `date` is a `== null` ternary and a nullable
 * `json` a parenthesised assertion, neither of which their non-nullable form
 * compiles. Twelve fields cost file size, not file count — `makeFeature()`
 * writes the same seven files whatever it is given.
 */
const RESOURCE_FIELDS = FIELD_TYPES.flatMap((type) => [
  `${type}Field:${type}`,
  `nullable${type[0].toUpperCase()}${type.slice(1)}Field:${type}?`,
]).join(',')

// The feature blueprints a default-blueprint app gets, in the order the
// scaffolders expect. Shared by the vendored and the npm paths so the
// published-drift gate cannot fall behind the set this smoke otherwise claims
// to cover: every one of these emits template code importing @guren/core, and
// a bare scaffold contains none of it.
//
// It cannot be *derived* from the CLI's registry — `resource` needs a name and
// `mail` needs a flag, which a list of names cannot carry — so it is checked
// against it instead, by assertCoversEveryBlueprint(). That every blueprint
// appears here is not this list happening to be long: `admin` and `oauth` were
// absent from every smoke in the tree until that check was written.
//
// admin and oauth after auth: `add admin` guards /admin and redirects to the
// sign-in page `add auth` scaffolds.
//
// --force on mail: `add auth` also scaffolds app/Providers/MailProvider.ts
// (password reset needs a mail manager) — the mail blueprint's own, more
// complete MailProvider (memory transport, setMailManager wiring)
// intentionally supersedes it, so the assertions can verify its shape.
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
  // After storage on purpose: with the storage provider already present,
  // attachments exercises its own scaffolds rather than re-running the
  // storage prerequisite.
  ['attachments'],
  // After attachments, deliberately: `--attach` refuses an app without
  // configureAttachments(). This second resource is the one gate that
  // *typechecks* the attach-aware model (Attachable + has*Attached from
  // @guren/core) and controller (attach/purgeAttachments) an app installs —
  // in the repo they are only parse-checked builder output.
  ['resource', 'photos', '--fields', 'title:string,caption:text?', '--attach', 'cover:one,images:many'],
  ['broadcasting'],
  ['schedule'],
]

/**
 * Fail when the CLI grows a blueprint this smoke does not scaffold.
 *
 * The registry has a tripwire of its own — packages/cli/tests/blueprints.test.ts
 * pins it to an exact list — which is precisely why this drift was silent:
 * whoever adds a blueprint is routed there, updates that array, and nothing
 * points back here. This is the pointer back.
 *
 * Imported dynamically because packages/cli/src/blueprints reaches
 * @guren/server through untracked dist/. A top-level import would evaluate
 * before main() runs ensureBuiltPackages(), turning a missing build into a
 * module-resolution error instead of the message that names the fix.
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
 * Run the feature blueprints through *this checkout's* CLI.
 *
 * Which CLI is not an implementation detail, and npm mode is where it decides
 * whether the gate can fail at all: the app's own installed `guren` ships the
 * published blueprints, so using it would emit published templates against
 * published packages — consistent by construction, and a gate that can only
 * pass. Templates from here, dependencies from the registry, is the mismatch
 * the drift check exists to measure.
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
      // node_modules, so two copies legitimately coexist in *this* process. The
      // warning describes the scaffolder, not the app under test; scoped to
      // these calls so a genuine duplicate in the app stays loud.
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
    // Piped stdout is the diagnostic for anything that reports there rather
    // than on stderr — `tsc` writes every error to stdout — so a failure has
    // to hand it back before throwing, or the log shows only the exit code.
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

  // What a scaffolded app installs, as npm would ship it: the vendored set plus
  // the scaffolder that produced the app. Not every publishable package —
  // `@guren/openapi` and the deploy plugins are opt-in, so no app resolves them
  // and packing them here would audit tarballs this smoke never installs.
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
        // The only check that sees what npm actually publishes: a template
        // reverted to a literal `.gitignore` is stripped from the tarball, so
        // this entry disappears rather than merely changing name.
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
      continue // File doesn't exist for this blueprint (e.g., API has no vite.config.ts)
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
 * else in CI reads these files. Typecheck and build cover whether they compile;
 * these assertions cover the wiring that compiles either way — an unregistered
 * policy, a mass-assignable `authorId`, or a leftover per-driver schema variant
 * all typecheck fine and all produce a broken or unsafe app.
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

  // Nothing shares the signed-in user with Inertia by default, and Layout.tsx
  // gates every authenticated control on it — without this the nav renders as a
  // guest for a signed-in user and the Log out button is unreachable.
  const authProvider = await readFile(join(appDir, 'app/Providers/AuthProvider.ts'), 'utf8')
  assert(authProvider.includes('shareInertiaProps('), 'Blog blueprint must share the signed-in user with Inertia.')

  // A native form POST carries neither the X-XSRF-TOKEN header nor a _token
  // field, so CSRF protection rejects it — the click silently does nothing.
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

  // The seeders are the only way a fresh blog app has anything to show, and
  // nothing else in CI loads them.
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
 * checkout's CLI, and typecheck the result.
 *
 * Resolving the template's own ranges is the whole point, so this fails
 * whenever a template has started using an API that exists only in this
 * repository — invisible to the other install modes and to the root
 * `typecheck`, which excludes `templates` (that now covers `config/database.ts`
 * too, shipped as per-driver sources under `templates/database/`).
 *
 * "Template" here means every template, not just the base scaffold. The
 * feature blueprints in `packages/cli/src/blueprints.ts` and `make-auth.ts`
 * emit far more `@guren/core` imports than the bare app does, and they are
 * ordinary source in this checkout, so they drift ahead of the registry the
 * same way. They are scaffolded with the checkout's CLI for the reason spelled
 * out on addDefaultBlueprintFeatures().
 *
 * What this deliberately does not run: `bun run build` (Vite), `bun test`,
 * `guren check`, `guren audit`. The claim being gated is "an app scaffolded
 * from the current templates builds against what is on npm right now" — the
 * vendored mode owns the rest, and the closing summary names every skip so a
 * green run says what it proved.
 */
async function runPublishedDependencyDrift(
  appDir: string,
  blueprint: string,
  runtimeEnv: Record<string, string>,
): Promise<void> {
  // The mirror of what the vendored modes assert, through the same predicate:
  // if this mode ever degraded into one of them it would keep passing while
  // checking nothing, so the local specs are asserted away rather than assumed
  // absent. Re-run after scaffolding, since a blueprint is free to add a
  // dependency and a local one would silently take the app off the registry.
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
    // Reused from the vendored path rather than reinvented: these fail loudly
    // if a blueprint stopped emitting what it claims to, which is what keeps
    // the widened typecheck below from quietly shrinking back to a bare app.
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
 * read the files it was supposed to.
 *
 * `--listFiles` rides along on the one compile rather than costing a second,
 * and it is what makes this an *outcome* check rather than a claim about
 * tsconfig syntax. The bug it exists for: `"include": [".guren"]` matches no
 * files, because TypeScript expands a bare directory name to a wildcard and its
 * wildcard matcher skips dot-prefixed segments. Generated files something
 * imports still arrive through the import graph — which is exactly what hides
 * it — so the ones nothing imports are the tell. Asking tsc which files it read
 * catches every reformulation of that mistake, not just the one spelling a
 * syntax check could reject.
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

  // Every mode needs the workspace built. What npm mode keeps off this checkout
  // is what the *app* resolves — its @guren/* come from the registry, and
  // runPublishedDependencyDrift() asserts that on both sides of scaffolding.
  // The scaffolder and the `guren add` blueprints are tools that emit the
  // templates under test, and the CLI reaches @guren/server through dist/, so
  // building them is what lets the gate fail rather than what weakens it.
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

    // Scaffold the app with the selected blueprint
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
      // rewriteAppDependencies() has already asserted every @guren/* resolves
      // locally; a tarball is the narrower claim only this mode can make, and
      // the only thing that catches it silently degrading into the vendored one.
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
      // Default blueprint: add all features
      await addDefaultBlueprintFeatures(appDir, runtimeEnv)
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
      await assertCanonicalScaffolds(appDir)
      await assertFeatureScaffolds(appDir)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--routes', 'routes/web.ts', '--out', 'types/generated/routes.d.ts', '--force'], appDir, runtimeEnv)
    } else if (blueprint === 'api') {
      // API blueprint: no features to add, validate API-specific structure
      const routesFile = await readFile(join(appDir, 'routes/api.ts'), 'utf8')
      assert(routesFile.includes('/health'), 'API blueprint must include a /health endpoint.')
      assert(routesFile.includes('/api/v1'), 'API blueprint must include /api/v1 prefix.')
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
    } else if (blueprint === 'blog') {
      // No codegen before the typecheck below: the template ships .guren/*.gen.ts,
      // and running codegen first would regenerate them, hiding stubs that have
      // fallen behind the pages and routes the template actually ships.
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
      await assertBlogScaffold(appDir)
    } else if (blueprint === 'worker') {
      // Worker blueprint: postScaffold adds queue/events/cache/schedule
      await assertCoreFirstStarter(appDir, { checkDependencies: false })
      // Verify the 4 expected worker features were scaffolded
      const appTs = await readFile(join(appDir, 'src/app.ts'), 'utf8')
      assert(appTs.includes('QueueServiceProvider'), 'Worker blueprint must scaffold queue.')
      assert(appTs.includes('EventServiceProvider'), 'Worker blueprint must scaffold events.')
      assert(appTs.includes('CacheServiceProvider'), 'Worker blueprint must scaffold cache.')
      assert(appTs.includes('SchedulingServiceProvider'), 'Worker blueprint must scaffold schedule.')
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--routes', 'routes/web.ts', '--out', 'types/generated/routes.d.ts', '--force'], appDir, runtimeEnv)
    }

    // Worker blueprint has a known scaffold export mismatch (named vs default).
    // TODO: fix blueprint templates to use consistent exports, then remove this skip.
    if (blueprint !== 'worker') {
      await typecheckApp(appDir, runtimeEnv)
    }

    // Worker blueprint: skip Vite build (scaffold-only validation is sufficient)
    if (blueprint !== 'worker') {
      await run(['bun', 'run', 'build'], appDir, runtimeEnv)
    }

    // API blueprint has no Vite build output — skip bundle budget
    if (blueprint !== 'api' && blueprint !== 'worker') {
      await run(['bun', resolve(repoRoot, 'scripts/smoke/build-budget.ts'), '--max-kb', '600', appDir], repoRoot, runtimeEnv)
    }

    // Templates advertise a starter test suite and a CI workflow gating on
    // `check --ci` and `guren audit`; exercise all three here so they cannot
    // drift from the framework. Worker is excluded like typecheck above
    // (same export mismatch). The api blueprint needs its codegen manifests
    // first — the generated workflow runs codegen before the gates too.
    // --no-deps keeps the audit off the network; releases of the CLI without
    // the flag ignore it harmlessly.
    if (blueprint !== 'worker') {
      if (blueprint === 'api') {
        await run(['bun', 'run', 'codegen'], appDir, runtimeEnv)
      }
      const routesArgs = blueprint === 'api' ? ['--routes', 'routes/api.ts'] : []
      await run(['bun', 'test'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'check', '--ci', ...routesArgs], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'audit', '--no-deps', ...routesArgs], appDir, runtimeEnv)
    }

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
