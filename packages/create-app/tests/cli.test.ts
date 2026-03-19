import { describe, expect, it, mock } from 'bun:test'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

let capturedCommand: any

await mock.module('citty', () => ({
  defineCommand: (command: any) => command,
  runMain: async (command: any) => {
    capturedCommand = command
  },
}))

await mock.module('consola', () => ({
  consola: {
    prompt: async () => 'ssr',
    success: mock(() => {}),
    info: mock(() => {}),
    log: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
    error: mock(() => {}),
  },
}))

await import('../src/cli')

describe('create-guren-app CLI', () => {
  it('scaffolds a SPA project and replaces tokens', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-')
    try {
      await capturedCommand.run({
        args: {
          target: 'my-app',
          force: false,
          mode: 'spa',
          auth: false,
        },
      })

      const appRoot = join(workspace.dir, 'my-app')
      const rawPackage = await readFile(join(appRoot, 'package.json'), 'utf8')
      const packageJson = JSON.parse(rawPackage) as { name: string; scripts?: Record<string, string> }

      expect(packageJson.name).toBe('my-app')
      expect(packageJson.scripts?.build).toBe('bunx vite build')

      const readme = await readFile(join(appRoot, 'README.md'), 'utf8')
      expect(readme).toContain('# My App')
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds an SSR project and updates build script', async () => {
    const workspace = await createTempWorkspace('guren-create-app-cli-ssr-')
    try {
      await capturedCommand.run({
        args: {
          target: 'ssr-app',
          force: false,
          mode: 'ssr',
          auth: false,
        },
      })

      const appRoot = join(workspace.dir, 'ssr-app')
      const rawPackage = await readFile(join(appRoot, 'package.json'), 'utf8')
      const packageJson = JSON.parse(rawPackage) as { scripts?: Record<string, string> }

      expect(packageJson.scripts?.build).toContain('--ssr')

      await access(join(appRoot, 'resources/js/ssr.tsx'))
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
})
