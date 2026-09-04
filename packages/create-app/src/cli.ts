import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { consola } from 'consola'
import { defineCommand, runMain } from 'citty'
import { DATABASE_DRIVERS, getAppBlueprint, listAppBlueprints, scaffoldAppBlueprint, usesDatabaseContainer, type DatabaseDriver, type RenderingMode } from './blueprints'
import { directoryExists, isDirectoryEmpty } from './utils'
import { initGitRepository, isInsideGitWorkTree } from './git'

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

async function runAppCli(targetDir: string, cliArgs: string[]): Promise<boolean> {
  // Run the CLI installed in the scaffolded app so the command sees the
  // app's own dependencies. A bare import of '@guren/cli' from create-guren-app
  // would fail: it is not a dependency of this package.
  const { spawnSync } = await import('node:child_process')
  const cliBin = resolve(targetDir, 'node_modules/@guren/cli/dist/bin.js')
  const result = spawnSync('bun', [cliBin, ...cliArgs], {
    cwd: targetDir,
    stdio: 'inherit',
  })
  return result.status === 0
}

async function resolveRenderingMode(flagValue: unknown): Promise<RenderingMode> {
  if (typeof flagValue === 'string') {
    const normalized = flagValue.toLowerCase()
    if (!RENDERING_MODE_SET.has(normalized as RenderingMode)) {
      throw new Error('Invalid rendering mode. Supported values are "spa" or "ssr".')
    }
    return normalized as RenderingMode
  }

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

// Mirrors AGENT_TARGETS in @guren/cli's agent-targets.ts — create-app cannot
// import it (the CLI is installed into the scaffolded app, not here), so
// tests/agent-choices-mirror.test.ts pins the two lists against each other.
const AGENT_CHOICES = ['claude', 'codex', 'cursor', 'copilot', 'opencode'] as const
type AgentChoice = (typeof AGENT_CHOICES)[number]
const AGENT_CHOICE_SET = new Set<string>(AGENT_CHOICES)
const AGENT_CHOICES_HELP = `Supported values are: ${AGENT_CHOICES.join(', ')}, all, none.`
const DEFAULT_AGENTS: AgentChoice[] = ['claude']

/**
 * The selection handed to `guren agent:init --target`: agent names, `['all']`
 * forwarded verbatim so the app's CLI owns the expansion, or null when the user
 * opted out of the harness entirely.
 */
async function resolveAgents(flagValue: unknown): Promise<string[] | null> {
  // citty accumulates a repeated --agents flag into an array; accept both
  const raw = Array.isArray(flagValue) ? flagValue.join(',') : flagValue
  if (typeof raw === 'string') {
    // a Set both dedupes (so `none,none` still reads as plain "none") and
    // preserves first-seen order for the --target list
    const parts = new Set(
      raw
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    )
    if (parts.size === 0) {
      throw new Error(`Invalid --agents value. ${AGENT_CHOICES_HELP}`)
    }
    if (parts.has('none')) {
      if (parts.size > 1) {
        throw new Error('--agents "none" cannot be combined with other values.')
      }
      return null
    }
    for (const part of parts) {
      if (part !== 'all' && !AGENT_CHOICE_SET.has(part)) {
        throw new Error(`Invalid agent "${part}". ${AGENT_CHOICES_HELP}`)
      }
    }
    return parts.has('all') ? ['all'] : [...parts]
  }

  if (!process.stdin.isTTY) {
    return DEFAULT_AGENTS
  }

  const result = await consola.prompt('Which AI coding agents should the agent harness support?', {
    type: 'multiselect',
    options: [
      { value: 'claude', label: 'Claude Code' },
      { value: 'codex', label: 'Codex' },
      { value: 'cursor', label: 'Cursor' },
      { value: 'copilot', label: 'GitHub Copilot' },
      { value: 'opencode', label: 'OpenCode' },
    ],
    initial: DEFAULT_AGENTS,
    required: false,
  })

  // an unexpected prompt shape falls back to the default like the sibling
  // resolvers do — never to "no harness"; only a selection positively read
  // as empty means the user deselected everything
  if (!Array.isArray(result)) {
    return DEFAULT_AGENTS
  }
  if (result.length === 0) {
    return null
  }
  const agents = result
    .map((entry) =>
      String(
        typeof entry === 'object' && entry !== null && 'value' in entry
          ? (entry as { value: unknown }).value
          : entry,
      ),
    )
    .filter((value) => AGENT_CHOICE_SET.has(value))
  return agents.length > 0 ? agents : DEFAULT_AGENTS
}

async function resolveGitInit(flagValue: unknown, target: { dir: string; wasEmpty: boolean }): Promise<boolean> {
  if (flagValue === false) {
    return false
  }

  // Nothing below can flip an unset flag to true, so bail before spawning git.
  if (flagValue !== true && !process.stdin.isTTY) {
    return false
  }

  const declined = (reason: string): false => {
    if (flagValue === true) {
      consola.warn(`Skipping git initialization: ${reason}`)
    }
    return false
  }

  // `git add -A` would sweep whatever was already here into the initial commit.
  if (!target.wasEmpty) {
    return declined('the target directory already contained files.')
  }

  // A nested repository inside an existing checkout is never what the user
  // wanted, so this wins even over an explicit --git.
  if (isInsideGitWorkTree(target.dir)) {
    return declined('the target directory is already inside a git repository.')
  }

  if (flagValue === true) {
    return true
  }

  const result = await consola.prompt('Initialize a git repository with an initial commit?', {
    type: 'confirm',
    initial: true,
  })

  return result === true
}

function reportGitInit(cwd: string): void {
  consola.start('Initializing git repository...')

  const result = initGitRepository(cwd)
  if (result.ok) {
    consola.success('Initialized a git repository with an initial commit')
    return
  }

  if (result.failedStep === 'commit') {
    consola.warn('Created a git repository, but the initial commit failed (git identity may be unset).')
    consola.warn('Set `git config user.name` and `git config user.email`, then run `git commit -m "chore: initial commit"`.')
    return
  }

  consola.warn(`Failed to run \`${result.command}\`. Initialize the repository manually.`)
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
    git: {
      type: 'boolean',
      description: 'Initialize a git repository and create an initial commit (prompted when interactive, off otherwise)',
    },
    agents: {
      type: 'string',
      description:
        'AI agents to set up the harness for: claude, codex, cursor, copilot, opencode, all, or none (prompted when interactive; default: claude)',
    },
  },
  async run({ args }) {
    const target = args.target as string
    const force = Boolean(args.force)
    const targetDir = resolve(process.cwd(), target)

    // Emptiness is checked even under --force: it also decides whether an
    // initial commit would sweep up files the scaffolder did not write.
    let targetWasEmpty = true
    if (await directoryExists(targetDir)) {
      targetWasEmpty = await isDirectoryEmpty(targetDir)
      if (!force && !targetWasEmpty) {
        throw new Error(`Directory "${targetDir}" is not empty. Use --force to scaffold anyway.`)
      }
    } else {
      await ensureTargetDirectory(targetDir, true)
    }

    const blueprint = getAppBlueprint(typeof args.blueprint === 'string' ? args.blueprint : undefined)
    const renderingMode = blueprint.name === 'api'
      ? 'spa'
      : await resolveRenderingMode(args.mode)
    const database = await resolveDatabase(args.db)
    // Asked here, applied last: every prompt runs before the long work starts.
    const agents = await resolveAgents(args.agents)
    const shouldInitGit = await resolveGitInit(args.git, { dir: targetDir, wasEmpty: targetWasEmpty })

    await scaffoldAppBlueprint({
      blueprint: blueprint.name,
      destination: targetDir,
      renderingMode,
      database,
    })

    if (renderingMode === 'ssr') {
      await updateSsrPackageJson(targetDir)
    }

    if (args.auth && blueprint.includesAuth) {
      consola.info(`The ${blueprint.name} blueprint already ships authentication — ignoring --auth.`)
    }
    const includeAuth = Boolean(args.auth) && !blueprint.includesAuth

    const shouldInstall = args.install !== false
    let installed = false
    if (shouldInstall) {
      installed = await installDependencies(targetDir)
    }

    if (agents === null) {
      consola.info(
        'Skipping the AI agent harness. Add it later with `bunx guren agent:init --target <agents>`.',
      )
    } else {
      const targetList = agents.join(',')
      let harnessInstalled = false
      if (installed) {
        consola.start('Setting up AI agent harness...')
        harnessInstalled = await runAppCli(targetDir, ['agent:init', '--target', targetList])
        if (harnessInstalled) {
          consola.success(`AI agent harness installed for: ${targetList}`)
        }
      }
      if (!harnessInstalled) {
        consola.warn(
          `AI agent harness was not installed automatically. Run \`bunx guren agent:init --target ${targetList}\` inside the app after installing dependencies.`,
        )
      }
    }

    let authInstalled = false
    if (includeAuth) {
      if (installed) {
        consola.start('Adding authentication scaffolding...')
        authInstalled = await runAppCli(targetDir, ['add', 'auth', '--force'])
        if (authInstalled) {
          consola.success('Authentication scaffolding added')
        }
      }
      if (!authInstalled) {
        consola.warn('Authentication was not scaffolded automatically. Run `bunx guren add auth` inside the app after installing dependencies.')
      }
    }

    // Last, so the harness and auth scaffolding land in the initial commit.
    if (shouldInitGit) {
      reportGitInit(targetDir)
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
    if (usesDatabaseContainer(database)) {
      consola.log('  bun run db:up')
    }
    consola.log('')
    consola.info('Add features:')
    if (!blueprint.includesAuth) {
      consola.log('  bunx guren add auth')
    }
    consola.log('  bunx guren add resource posts --fields "title:string,body:text"')
    consola.log('')
    consola.info('Generate types and set up database:')
    consola.log('  bun run codegen')
    consola.log('  bun run db:make')
    consola.log('  bun run db:migrate')
    consola.log('  bun run db:seed')
    consola.log('')
    consola.info('Verify and run:')
    consola.log('  bun run typecheck')
    consola.log('  bun run test')
    consola.log('  bun run dev')

    if (authInstalled) {
      consola.log('')
      consola.info('Auth scaffolding was included automatically.')
      // db:make first: the users table only exists in db/schema.ts until
      // drizzle-kit generates a migration from it, and db:migrate with an empty
      // db/migrations applies nothing.
      consola.info('Set up the users table with: bun run db:make && bun run db:migrate && bun run db:seed')
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
