import { describe, expect, it, mock } from 'bun:test'
import { readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { DATABASE_DRIVERS } from '../src/blueprints'
import { GIT_TIMEOUT_MS } from '../src/git'
import { createTempWorkspace, useGitIdentity } from './helpers'

let capturedCommand: any
const successMock = mock(() => {})
const infoMock = mock(() => {})
const logMock = mock(() => {})
const warnMock = mock(() => {})
const debugMock = mock(() => {})
const errorMock = mock(() => {})

// mock.module() replacements are not undone by mock.restore() and leak into
// other test files through the shared module registry, even with --isolate. So
// spread the real module and override only runMain, leaving leaked imports the
// real defineCommand/runCommand.
const realCitty = await import('citty')
await mock.module('citty', () => ({
  ...realCitty,
  runMain: async (command: any) => {
    capturedCommand = command
  },
}))

const consolaStub = {
  prompt: async () => 'ssr',
  start: mock(() => {}),
  success: successMock,
  info: infoMock,
  log: logMock,
  warn: warnMock,
  debug: debugMock,
  error: errorMock,
}

await mock.module('consola', () => ({
  consola: consolaStub,
  default: consolaStub,
  createConsola: () => consolaStub,
  LogLevels: {},
}))

await import('../src/cli')

useGitIdentity()

// Derived, not a second literal: staying above the scaffolder's own git budget
// makes a wedged `git` surface as its "initialize the repository manually"
// warning rather than a bare timeout, whose blocking time Bun charges to the
// *next* test.
const GIT_TEST_TIMEOUT_MS = GIT_TIMEOUT_MS * 2

function logged(target: typeof warnMock, text: string): boolean {
  return target.mock.calls.some((call) => call.join(' ').includes(text))
}

describe('create-guren-app CLI', () => {
  it('scaffolds a SPA project and replaces tokens', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-')
    try {
      warnMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'my-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'my-app')
      const rawPackage = await readFile(join(appRoot, 'package.json'), 'utf8')
      const packageJson = JSON.parse(rawPackage) as { name: string; scripts?: Record<string, string> }
      const envExample = await readFile(join(appRoot, '.env.example'), 'utf8')
      const env = await readFile(join(appRoot, '.env'), 'utf8')

      expect(packageJson.name).toBe('my-app')
      expect(packageJson.scripts?.build).toBe('bun run codegen && bunx vite build')
      expect(packageJson.scripts?.typecheck).toBe('tsc --noEmit')
      expect(envExample).toContain('APP_KEY=')
      expect(env).toContain('APP_KEY=base64:')
      expect(envExample).not.toContain('\nVITE_DEV_SERVER_URL=')
      expect(env).not.toContain('\nVITE_DEV_SERVER_URL=')
      expect(envExample).toContain('# VITE_DEV_SERVER_URL=http://localhost:5173')
      expect(env).toContain('# VITE_DEV_SERVER_URL=http://localhost:5173')

      const readme = await readFile(join(appRoot, 'README.md'), 'utf8')
      expect(readme).toContain('# My App')

      const seedAdr = await readFile(
        join(appRoot, 'docs/adr/0001-record-architecture-decisions.md'),
        'utf8',
      )
      expect(seedAdr).toContain('type: adr')
      expect(seedAdr).toContain('make:adr')

      // Harness install requires dependencies; without install we point at agent:init
      await expect(access(join(appRoot, 'CLAUDE.md'))).rejects.toThrow()
      expect(warnMock.mock.calls.some((call) => call.join(' ').includes('bunx guren agent:init'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips the agent harness entirely with --agents none', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-agents-none-')
    try {
      infoMock.mockClear()
      warnMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'no-harness-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          // duplicates collapse before the "none is exclusive" check
          agents: 'none,none',
        },
      })

      expect(logged(infoMock, 'Skipping the AI agent harness')).toBe(true)
      expect(logged(warnMock, 'agent harness was not installed')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('accepts a repeated --agents flag as accumulated by the arg parser', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-agents-repeat-')
    try {
      warnMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'repeat-agents-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          agents: ['codex', 'cursor'],
        },
      })

      expect(logged(warnMock, 'bunx guren agent:init --target codex,cursor')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('forwards --agents all verbatim so the app CLI owns the expansion', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-agents-all-')
    try {
      warnMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'all-agents-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          agents: 'all',
        },
      })

      expect(logged(warnMock, 'bunx guren agent:init --target all')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('suggests the selected targets when the harness could not be installed', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-agents-list-')
    try {
      warnMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'multi-agent-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          agents: 'codex, cursor',
        },
      })

      expect(logged(warnMock, 'bunx guren agent:init --target codex,cursor')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects an unknown --agents value before scaffolding work begins', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-agents-bad-')
    try {
      const appDir = join(workspace.dir, 'bad-agents-app')
      await expect(
        capturedCommand.run({
          args: {
            target: appDir,
            force: false,
            mode: 'spa',
            auth: false,
            db: 'sqlite',
            install: false,
            agents: 'all,claud',
          },
        }),
      ).rejects.toThrow('Invalid agent "claud"')

      // the throw happened before the template copy, not after
      await expect(access(join(appDir, 'package.json'))).rejects.toThrow()
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds an SSR project and updates build script', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-ssr-')
    try {
      infoMock.mockClear()
      logMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'ssr-app'),
          force: false,
          mode: 'ssr',
          auth: false,
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'ssr-app')
      const rawPackage = await readFile(join(appRoot, 'package.json'), 'utf8')
      const packageJson = JSON.parse(rawPackage) as { scripts?: Record<string, string> }

      expect(packageJson.scripts?.build).toContain('--ssr')

      await access(join(appRoot, 'resources/js/ssr.tsx'))

      expect(infoMock.mock.calls.some((call) => call.join(' ').includes('Optional deploy path:'))).toBe(true)
      expect(logMock.mock.calls.some((call) => call.join(' ').includes('bunx guren plugin @guren/plugin-vercel'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds the blog blueprint on top of the default template', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-blog-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'blog-app'),
          force: false,
          mode: 'ssr',
          auth: false,
          blueprint: 'blog',
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'blog-app')

      // The overlay copies last, so its files must win over the base template's.
      const home = await readFile(join(appRoot, 'resources/js/pages/Home.tsx'), 'utf8')
      expect(home).toContain('Latest posts')

      // Tokens are replaced in the overlay's own files, not just the base's.
      const layout = await readFile(join(appRoot, 'resources/js/components/Layout.tsx'), 'utf8')
      expect(layout).toContain('Blog App')
      expect(layout).not.toContain('__APP_TITLE__')

      // ...without dropping the SSR layer the base blueprint contributes.
      await access(join(appRoot, 'resources/js/ssr.tsx'))

      await access(join(appRoot, 'app/Http/Controllers/PostController.ts'))
      await access(join(appRoot, 'app/Policies/PostPolicy.ts'))
      await access(join(appRoot, 'db/seeders/002_posts.ts'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('keeps only the selected driver schema and never the generic one', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-blog-schema-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'pg-blog'),
          force: false,
          mode: 'spa',
          auth: false,
          blueprint: 'blog',
          db: 'postgres',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'pg-blog')
      const schema = await readFile(join(appRoot, 'db/schema.ts'), 'utf8')

      expect(schema).toContain('pgTable')
      // The generic schema has no posts table — writing it over a template that
      // ships its own is what broke the blueprint this one replaces.
      expect(schema).toContain('export const posts')

      for (const driver of DATABASE_DRIVERS) {
        await expect(access(join(appRoot, `db/schema.${driver}.ts`))).rejects.toThrow()
      }
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores --auth for a blueprint that already ships it', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-blog-auth-')
    try {
      infoMock.mockClear()
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'auth-blog'),
          force: false,
          mode: 'spa',
          auth: true,
          blueprint: 'blog',
          db: 'sqlite',
          install: false,
        },
      })

      // `guren add auth --force` would overwrite the template's own controllers,
      // routes, and User model with the generic ones.
      expect(infoMock.mock.calls.some((call) => call.join(' ').includes('already ships authentication'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects invalid rendering modes', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-invalid-')
    try {
      await expect(
        capturedCommand.run({
          args: {
            target: join(workspace.dir, 'bad-app'),
            force: false,
            mode: 'invalid',
            auth: false,
          },
        }),
      ).rejects.toThrow('Invalid rendering mode')
    } finally {
      await workspace.cleanup()
    }
  })

  it('rejects invalid blueprint names', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-bad-blueprint-')
    try {
      await expect(
        capturedCommand.run({
          args: {
            target: join(workspace.dir, 'bad-app'),
            force: false,
            mode: 'spa',
            auth: false,
            blueprint: 'unknown',
          },
        }),
      ).rejects.toThrow('Unknown blueprint')
    } finally {
      await workspace.cleanup()
    }
  })

  it('gives container-backed drivers a single driver dependency and db:up/db:down scripts', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-postgres-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'pg-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'postgres',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'pg-app')
      await access(join(appRoot, 'docker-compose.yml'))

      const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }

      expect(packageJson.scripts?.['db:up']).toBe('docker compose up -d')
      expect(packageJson.scripts?.['db:down']).toBe('docker compose down')

      // Listing the driver in both trees makes `bun install` warn about a
      // duplicate dependency on the very first command a user runs.
      expect(packageJson.dependencies?.postgres).toBeDefined()
      expect(packageJson.devDependencies?.postgres).toBeUndefined()
      expect(packageJson.devDependencies?.mysql2).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds a .gitignore, which npm would have stripped from the template', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-gitignore-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'ignored-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'ignored-app')
      const gitignore = await readFile(join(appRoot, '.gitignore'), 'utf8')

      expect(gitignore).toContain('node_modules')
      expect(gitignore).toContain('.env')
      expect(gitignore).toContain('public/assets/')

      // The nested one guards the codegen output under types/generated/.
      const nested = await readFile(join(appRoot, 'types/generated/.gitignore'), 'utf8')
      expect(nested).toContain('routes.d.ts')

      await expect(access(join(appRoot, '_gitignore'))).rejects.toThrow()
    } finally {
      await workspace.cleanup()
    }
  })

  // NOT a test of overlay precedence: `default-ssr` ships no `_gitignore`, so
  // no current blueprint can demonstrate an overlay's ignore file replacing the
  // base one. This covers the multi-layer path only.
  it('restores the .gitignore in a multi-layer scaffold', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-gitignore-overlay-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'ssr-ignored'),
          force: false,
          mode: 'ssr',
          auth: false,
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'ssr-ignored')
      expect(await readFile(join(appRoot, '.gitignore'), 'utf8')).toContain('.guren/ssr/')
      await expect(access(join(appRoot, '_gitignore'))).rejects.toThrow()
    } finally {
      await workspace.cleanup()
    }
  })

  it('initializes a git repository without committing the generated .env', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-git-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'git-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          git: true,
        },
      })

      const appRoot = join(workspace.dir, 'git-app')

      // `git add -A` alone populates the index, so assert the commit landed —
      // otherwise a broken commit step would still leave ls-files green.
      const head = spawnSync('git', ['log', '--format=%s', '-1'], { cwd: appRoot, encoding: 'utf8' })
      expect(head.status).toBe(0)
      expect(head.stdout.trim()).toBe('chore: initial commit')

      // Read the commit itself, not the index, for the same reason.
      const files = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: appRoot, encoding: 'utf8' })
        .stdout.split('\n').filter(Boolean)

      // .env holds the freshly generated APP_KEY and must never be committed.
      expect(files).not.toContain('.env')
      expect(files).toContain('.env.example')
      expect(files).toContain('.gitignore')
      expect(files).toContain('package.json')
    } finally {
      await workspace.cleanup()
    }
  }, GIT_TEST_TIMEOUT_MS)

  it('does not commit pre-existing files when --force scaffolds into a used directory', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-git-force-')
    try {
      warnMock.mockClear()
      const appRoot = join(workspace.dir, 'used-app')
      await mkdir(appRoot, { recursive: true })
      await writeFile(join(appRoot, 'credentials.json'), '{"token":"secret"}\n', 'utf8')

      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'used-app'),
          force: true,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          git: true,
        },
      })

      await expect(access(join(appRoot, '.git'))).rejects.toThrow()
      expect(warnMock.mock.calls.some((call) => call.join(' ').includes('already contained files'))).toBe(true)

      // The pre-existing file must survive the scaffold untouched either way.
      expect(await readFile(join(appRoot, 'credentials.json'), 'utf8')).toContain('secret')
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves a pre-existing _gitignore in the target directory alone', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-force-dotfile-')
    try {
      const appRoot = join(workspace.dir, 'forced-app')
      await mkdir(join(appRoot, 'vendor'), { recursive: true })
      await writeFile(join(appRoot, 'vendor/_gitignore'), 'not-a-template\n', 'utf8')

      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'forced-app'),
          force: true,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
        },
      })

      // Only files this scaffold wrote get the dot restored.
      expect(await readFile(join(appRoot, 'vendor/_gitignore'), 'utf8')).toBe('not-a-template\n')
      await expect(access(join(appRoot, 'vendor/.gitignore'))).rejects.toThrow()
      await access(join(appRoot, '.gitignore'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not nest a repository inside an existing git work tree', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-git-nested-')
    try {
      warnMock.mockClear()
      expect(spawnSync('git', ['init'], { cwd: workspace.dir }).status).toBe(0)

      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'nested-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
          git: true,
        },
      })

      await expect(access(join(workspace.dir, 'nested-app/.git'))).rejects.toThrow()
      expect(warnMock.mock.calls.some((call) => call.join(' ').includes('already inside a git repository'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  }, GIT_TEST_TIMEOUT_MS)

  it('leaves SQLite projects without container scripts or driver packages', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-sqlite-db-')
    try {
      await capturedCommand.run({
        args: {
          target: join(workspace.dir, 'lite-app'),
          force: false,
          mode: 'spa',
          auth: false,
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'lite-app')
      await expect(access(join(appRoot, 'docker-compose.yml'))).rejects.toThrow()

      const packageJson = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
      }

      expect(packageJson.scripts?.['db:up']).toBeUndefined()
      expect(packageJson.dependencies?.postgres).toBeUndefined()
      expect(packageJson.devDependencies?.postgres).toBeUndefined()
      expect(packageJson.devDependencies?.mysql2).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })
})
