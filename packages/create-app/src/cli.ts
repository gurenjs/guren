import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import { defineCommand, runMain } from 'citty'
import { DATABASE_DRIVERS, getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint, type DatabaseDriver, type RenderingMode } from './blueprints'
import { directoryExists, isDirectoryEmpty } from './utils'

const RENDERING_MODES = ['spa', 'ssr'] as const
const RENDERING_MODE_SET = new Set<RenderingMode>(RENDERING_MODES)
const DATABASE_DRIVER_SET = new Set<DatabaseDriver>(DATABASE_DRIVERS)

async function ensureTargetDirectory(path: string, force: boolean): Promise<void> {
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Path "${path}" exists and is not a directory.`)
    }

    throw error
  }

  if (!force) {
    const empty = await isDirectoryEmpty(path)
    if (!empty) {
      throw new Error(`Directory "${path}" is not empty. Use --force to scaffold anyway.`)
    }
  }
}

async function updateSsrPackageJson(destination: string): Promise<void> {
  const packageJsonPath = resolve(destination, 'package.json')
  const raw = await readFile(packageJsonPath, 'utf8')
  const pkg = JSON.parse(raw) as { scripts?: Record<string, string> }

  pkg.scripts ??= {}
  pkg.scripts.build = 'bun run codegen && bunx vite build && bunx vite build --ssr'

  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
}

async function installAuthBlueprint(): Promise<void> {
  const { runBlueprint } = await import('@guren/cli')
  await runBlueprint('auth', { force: true })
}

async function resolveRenderingMode(flagValue: unknown): Promise<RenderingMode> {
  if (typeof flagValue === 'string') {
    const normalized = flagValue.toLowerCase()
    if (!RENDERING_MODE_SET.has(normalized as RenderingMode)) {
      throw new Error('Invalid rendering mode. Supported values are "spa" or "ssr".')
    }
    return normalized as RenderingMode
  }

  // In non-interactive environments (CI, piped stdin), default to SSR
  if (!process.stdin.isTTY) {
    return 'ssr'
  }

  const result = await consola.prompt('Choose the rendering mode for this project', {
    type: 'select',
    options: [
      { value: 'ssr', label: 'SSR (server-side rendering)' },
      { value: 'spa', label: 'SPA (client-side rendering only)' },
    ],
    initial: 'ssr',
    default: 'ssr',
  })

  const value = typeof result === 'string' ? result : 'ssr'

  return (value as RenderingMode) ?? 'ssr'
}

async function resolveDatabase(flagValue: unknown): Promise<DatabaseDriver> {
  if (typeof flagValue === 'string') {
    const normalized = flagValue.toLowerCase()
    if (!DATABASE_DRIVER_SET.has(normalized as DatabaseDriver)) {
      throw new Error(`Invalid database driver. Supported values are: ${DATABASE_DRIVERS.join(', ')}`)
    }
    return normalized as DatabaseDriver
  }

  if (!process.stdin.isTTY) {
    return 'sqlite'
  }

  const result = await consola.prompt('Choose the database driver', {
    type: 'select',
    options: [
      { value: 'sqlite', label: 'SQLite (zero-config, recommended for getting started)' },
      { value: 'postgres', label: 'PostgreSQL' },
      { value: 'mysql', label: 'MySQL' },
    ],
    initial: 'sqlite',
    default: 'sqlite',
  })

  const value = typeof result === 'string' ? result : 'sqlite'
  return (value as DatabaseDriver) ?? 'sqlite'
}

async function installDependencies(cwd: string): Promise<boolean> {
  try {
    consola.start('Installing dependencies...')
    const { spawnSync } = await import('node:child_process')
    const result = spawnSync('bun', ['install'], { cwd, stdio: 'inherit' })
    if (result.status !== 0) {
      consola.warn('Failed to install dependencies. Run `bun install` manually.')
      return false
    }
    consola.success('Dependencies installed')
    return true
  } catch {
    consola.warn('Failed to install dependencies. Run `bun install` manually.')
    return false
  }
}

const command = defineCommand({
  meta: {
    name: 'create-guren-app',
    description: 'Scaffold a new Guren application.',
  },
  args: {
    target: {
      type: 'positional',
      description: 'Directory to create the application in',
      default: '.',
    },
    force: {
      type: 'boolean',
      alias: 'f',
      description: 'Overwrite existing files in the target directory',
    },
    mode: {
      type: 'string',
      description: 'Rendering mode to scaffold (spa or ssr)',
    },
    auth: {
      type: 'boolean',
      description: 'Include authentication scaffolding with auto-configured providers and middleware',
    },
    blueprint: {
      type: 'string',
      description: `Starter blueprint to scaffold (${listAppBlueprints().join(', ')})`,
    },
    db: {
      type: 'string',
      description: `Database driver (${DATABASE_DRIVERS.join(', ')})`,
    },
    install: {
      type: 'boolean',
      description: 'Install dependencies after scaffolding (default: true)',
      default: true,
    },
  },
  async run({ args }) {
    const target = args.target as string
    const force = Boolean(args.force)
    const targetDir = resolve(process.cwd(), target)

    if (await directoryExists(targetDir)) {
      if (!force) {
        const empty = await isDirectoryEmpty(targetDir)
        if (!empty) {
          throw new Error(`Directory "${targetDir}" is not empty. Use --force to scaffold anyway.`)
        }
      }
    } else {
      await ensureTargetDirectory(targetDir, true)
    }

    const blueprint = getAppBlueprint(typeof args.blueprint === 'string' ? args.blueprint : undefined)
    const renderingMode = blueprint.name === 'api'
      ? 'spa'
      : await resolveRenderingMode(args.mode)
    const database = await resolveDatabase(args.db)

    await scaffoldAppBlueprint({
      blueprint: blueprint.name,
      destination: targetDir,
      renderingMode,
      database,
    })

    if (renderingMode === 'ssr') {
      await updateSsrPackageJson(targetDir)
    }

    const includeAuth = Boolean(args.auth)

    if (includeAuth) {
      const originalCwd = process.cwd()
      try {
        process.chdir(targetDir)
        await installAuthBlueprint()
      } catch (error) {
        consola.warn('Failed to scaffold authentication automatically. You can run it manually after install with `bunx guren add auth`.')
        consola.debug(error)
      } finally {
        process.chdir(originalCwd)
      }
    }

    const shouldInstall = args.install !== false
    let installed = false
    if (shouldInstall) {
      installed = await installDependencies(targetDir)
    }

    const relativeTarget = relative(process.cwd(), targetDir) || '.'

    consola.success(`Scaffolded a new Guren app (${blueprint.name}/${renderingMode.toUpperCase()}/${database}) in ${relativeTarget}`)
    consola.info('Next steps:')
    if (relativeTarget !== '.') {
      consola.log(`  cd ${relativeTarget}`)
    }
    if (!installed) {
      consola.log('  bun install')
    }
    if (database !== 'sqlite') {
      consola.log('  docker compose up -d')
    }
    consola.log('')
    consola.info('Add features:')
    consola.log('  bunx guren add auth')
    consola.log('  bunx guren add resource posts --fields "title:string,body:text"')
    consola.log('')
    consola.info('Generate types and set up database:')
    consola.log('  bun run codegen')
    consola.log('  bun run db:migrate')
    consola.log('  bun run db:seed')
    consola.log('')
    consola.info('Verify and run:')
    consola.log('  bun run typecheck')
    consola.log('  bun run test')
    consola.log('  bun run dev')

    if (includeAuth) {
      consola.log('')
      consola.info('Auth scaffolding was included automatically.')
    }

    if (renderingMode === 'ssr') {
      consola.log('')
      consola.info('Production build:')
      consola.log('  bun run build')
      consola.log('')
      consola.info('Optional deploy path:')
      consola.log('  bunx guren plugin @guren/plugin-vercel')
      consola.log('  bun add @guren/plugin-vercel')
    }
  },
})

runMain(command).catch((error) => {
  if (error instanceof Error) {
    consola.error(error.message)
  } else {
    consola.error(String(error))
  }
  process.exit(1)
})
