import { describe, expect, it, mock } from 'bun:test'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

let capturedCommand: any
const successMock = mock(() => {})
const infoMock = mock(() => {})
const logMock = mock(() => {})
const warnMock = mock(() => {})
const debugMock = mock(() => {})
const errorMock = mock(() => {})

// Bun runs all test files in one shared process, and mock.module()
// replacements are not undone by mock.restore() — even with --isolate the
// replacement leaks into other test files through the shared module
// registry. Spread the real module and override only runMain (all this file
// needs), so leaked imports still get the real defineCommand/runCommand —
// stubbing runCommand here silently broke the plugin-commands tests.
const realCitty = await import('citty')
await mock.module('citty', () => ({
  ...realCitty,
  runMain: async (command: any) => {
    capturedCommand = command
  },
}))

const consolaStub = {
  prompt: async () => 'ssr',
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

describe('create-guren-app CLI', () => {
  it('scaffolds a SPA project and replaces tokens', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-')
    try {
      warnMock.mockClear()
      await capturedCommand.run({
        args: {
          target: 'my-app',
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
      expect(seedAdr).toContain('kind: adr')
      expect(seedAdr).toContain('make:adr')

      // Harness install requires dependencies; without install we point at agent:init
      await expect(access(join(appRoot, 'CLAUDE.md'))).rejects.toThrow()
      expect(warnMock.mock.calls.some((call) => call.join(' ').includes('bunx guren agent:init'))).toBe(true)
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
          target: 'ssr-app',
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

  it('accepts the blog blueprint alias', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-blueprint-')
    try {
      await capturedCommand.run({
        args: {
          target: 'blog-app',
          force: false,
          mode: 'spa',
          auth: false,
          blueprint: 'blog',
          db: 'sqlite',
          install: false,
        },
      })

      const appRoot = join(workspace.dir, 'blog-app')
      const rawPackage = await readFile(join(appRoot, 'package.json'), 'utf8')
      const packageJson = JSON.parse(rawPackage) as {
        name: string
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
      }

      expect(packageJson.name).toBe('blog-app')
      expect(packageJson.scripts?.typecheck).toBe('tsc --noEmit')
      expect(packageJson.dependencies?.['@guren/core']).toBeDefined()
      expect(packageJson.dependencies?.zod).toBeDefined()

      await access(join(appRoot, 'app/Services/PostCacheService.ts'))
      await access(join(appRoot, 'config/inertia.ts'))
      await access(join(appRoot, 'smoke.ts'))

      await expect(access(join(appRoot, 'db/migrations/20251103140602_worried_oracle/migration.sql'))).rejects.toThrow()
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
            target: 'bad-app',
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
            target: 'bad-app',
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
          target: 'pg-app',
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

  it('leaves SQLite projects without container scripts or driver packages', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-sqlite-db-')
    try {
      await capturedCommand.run({
        args: {
          target: 'lite-app',
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
