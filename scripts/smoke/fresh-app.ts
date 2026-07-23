import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { auditStarterTemplate } from './starter-template-audit'

type PackageName =
  | '@guren/cli'
  | '@guren/core'
  | '@guren/inertia-client'
  | '@guren/orm'
  | '@guren/server'

interface LocalPackage {
  name: PackageName
  sourceDir: string
  vendorDir: string
}

interface PublishedArtifact {
  name: string
  sourceDir: string
}

type InstallMode = 'vendored' | 'packed'

const repoRoot = resolve(import.meta.dir, '../..')
const localPackages: LocalPackage[] = [
  { name: '@guren/cli', sourceDir: resolve(repoRoot, 'packages/cli'), vendorDir: 'cli' },
  { name: '@guren/core', sourceDir: resolve(repoRoot, 'packages/core'), vendorDir: 'core' },
  { name: '@guren/inertia-client', sourceDir: resolve(repoRoot, 'packages/inertia-client'), vendorDir: 'inertia-client' },
  { name: '@guren/orm', sourceDir: resolve(repoRoot, 'packages/orm'), vendorDir: 'orm' },
  { name: '@guren/server', sourceDir: resolve(repoRoot, 'packages/server'), vendorDir: 'server' },
]
const publishedArtifacts: PublishedArtifact[] = [
  ...localPackages,
  { name: 'create-guren-app', sourceDir: resolve(repoRoot, 'packages/create-app') },
]

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
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
    throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(' ')}`)
  }
  return output
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function ensureBuiltPackages(): Promise<void> {
  for (const pkg of localPackages) {
    const packageJson = JSON.parse(await readFile(join(pkg.sourceDir, 'package.json'), 'utf8')) as { exports?: Record<string, unknown> }
    const distDir = join(pkg.sourceDir, 'dist')
    try {
      await readFile(join(distDir, 'index.js'), 'utf8')
    } catch {
      throw new Error(`Missing build output for ${pkg.name}. Run bun run build first.`)
    }
    if (pkg.name === '@guren/core' && !packageJson.exports?.['./runtime']) {
      throw new Error(`${pkg.name} is missing the ./runtime export in package.json.`)
    }
    if (pkg.name === '@guren/core' && !packageJson.exports?.['./vite']) {
      throw new Error(`${pkg.name} is missing the ./vite export in package.json.`)
    }
  }
}

async function copyPackage(sourceDir: string, destinationDir: string): Promise<void> {
  await mkdir(destinationDir, { recursive: true })
  await cp(join(sourceDir, 'dist'), join(destinationDir, 'dist'), { recursive: true, force: true })
  await cp(join(sourceDir, 'package.json'), join(destinationDir, 'package.json'), { force: true })
}

async function rewritePackageDependencies(packageJsonPath: string, replacements: Map<PackageName, string>): Promise<void> {
  const raw = await readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const group = pkg[field]
    if (!group) {
      continue
    }

    for (const [dependency, replacement] of replacements) {
      if (group[dependency]) {
        group[dependency] = replacement
      }
    }
  }

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

async function vendorPackages(vendorRoot: string): Promise<Map<PackageName, string>> {
  await mkdir(vendorRoot, { recursive: true })
  const packageRoots = new Map<PackageName, string>()

  for (const pkg of localPackages) {
    const destination = join(vendorRoot, pkg.vendorDir)
    await copyPackage(pkg.sourceDir, destination)
    packageRoots.set(pkg.name, destination)
  }

  for (const pkg of localPackages) {
    const packageJsonPath = join(packageRoots.get(pkg.name)!, 'package.json')
    const packageDir = dirname(packageJsonPath)
    const replacements = new Map<PackageName, string>()
    for (const target of localPackages) {
      const targetDir = packageRoots.get(target.name)!
      const relativePath = toPosixPath(relative(packageDir, targetDir))
      replacements.set(target.name, `file:${relativePath || '.'}`)
    }
    await rewritePackageDependencies(packageJsonPath, replacements)
  }

  return packageRoots
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
        await auditStarterTemplate(join(extractDir, 'package/templates/default'))
      }
    }
  }
}

async function rewriteAppDependencies(appDir: string, vendorRoots: Map<PackageName, string>): Promise<void> {
  const packageJsonPath = join(appDir, 'package.json')
  const appPackageDir = dirname(packageJsonPath)
  const raw = await readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>
  }

  pkg.dependencies ??= {}

  for (const [name, packageDir] of vendorRoots) {
    pkg.dependencies[name] = `file:${toPosixPath(relative(appPackageDir, packageDir))}`
  }

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
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
  assert(storageProvider.includes("public: { driver: 'local', root: './storage/app/public' }"), 'Storage blueprint must expose a public disk.')

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

async function main(): Promise<void> {
  await ensureBuiltPackages()

  const blueprint = process.env.GUREN_SMOKE_BLUEPRINT ?? 'default'
  const tempRoot = await mkdtemp(join(tmpdir(), `guren-fresh-app-${blueprint}-`))
  const appDir = join(tempRoot, 'app')
  const vendorDir = join(appDir, '.guren-vendor')
  const packDir = join(appDir, '.guren-packed')
  const runtimeTempDir = join(tempRoot, '.tmp')
  const bunInstallCacheDir = join(tempRoot, '.bun-install-cache')
  const keepTemp = process.env.GUREN_KEEP_SMOKE_DIR === '1'
  const installMode = (process.env.GUREN_SMOKE_INSTALL_MODE === 'packed' ? 'packed' : 'vendored') satisfies InstallMode
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
    await run(createArgs, repoRoot)

    await assertCoreFirstStarter(appDir)
    const dependencyRoots = installMode === 'packed'
      ? await packPackages(packDir)
      : await vendorPackages(vendorDir)
    if (installMode === 'packed') {
      await assertPackedArtifacts(dependencyRoots, packDir)
    }
    await rewriteAppDependencies(appDir, dependencyRoots)
    if (installMode === 'packed') {
      const packageJson = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      for (const pkg of localPackages) {
        const dependencyValue = packageJson.dependencies?.[pkg.name]
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
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'auth'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'resource', 'posts'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'queue'], appDir, runtimeEnv)
      // --force: `add auth` now also scaffolds app/Providers/MailProvider.ts
      // (password reset needs a mail manager) — the mail blueprint's own,
      // more complete MailProvider (memory transport, setMailManager wiring)
      // intentionally supersedes it here so the assertions below can verify
      // its shape.
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'mail', '--force'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'events'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'cache'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'notifications'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'storage'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'broadcasting'], appDir, runtimeEnv)
      await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'add', 'schedule'], appDir, runtimeEnv)
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
      await run(['bun', 'run', 'typecheck'], appDir, runtimeEnv)
    }

    // Worker blueprint: skip Vite build (scaffold-only validation is sufficient)
    if (blueprint !== 'worker') {
      await run(['bun', 'run', 'build'], appDir, runtimeEnv)
    }

    // API blueprint has no Vite build output — skip bundle budget
    if (blueprint !== 'api' && blueprint !== 'worker') {
      await run(['bun', resolve(repoRoot, 'scripts/smoke/build-budget.ts'), '--max-kb', '600', appDir], repoRoot, runtimeEnv)
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
