import { describe, expect, it, mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import {
  bootstrapApplication,
  loadApplication,
  loadBootedApplication,
  ensureApplicationBooted,
  importFirstAvailableApplicationModule,
  resolveMainEntry,
} from '../src/runtime'

describe('runtime helpers', () => {
  it('resolves the main entry from the workspace', async () => {
    const workspace = await createTempWorkspace('guren-cli-runtime-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/main.ts'), 'export default {}', 'utf8')

      const entry = await resolveMainEntry()
      expect(entry.endsWith('src/main.ts')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('bootstraps applications from module exports', async () => {
    const app = { listen: mock(() => {}) }
    await expect(bootstrapApplication({ default: app })).resolves.toBe(app)

    const readyApp = { listen: mock(() => {}) }
    await expect(bootstrapApplication({ ready: Promise.resolve(readyApp) })).resolves.toBe(readyApp)
  })

  it('runs app boot when module does not handle boot', async () => {
    const app = { boot: mock(async () => {}) }

    await ensureApplicationBooted(app, {})
    expect(app.boot).toHaveBeenCalledTimes(1)
  })

  it('skips app boot when module provides ready', async () => {
    const app = { boot: mock(async () => {}) }
    const moduleExports = { ready: Promise.resolve({ listen: () => {} }) }

    await ensureApplicationBooted(app, moduleExports)
    expect(app.boot).not.toHaveBeenCalled()
  })

  it('leaves a default application boot to its caller, while the live loader propagates failure', async () => {
    const workspace = await createTempWorkspace('guren-runtime-boot-policy-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/main.ts'), `export default { listen() {}, boot() { throw new Error('boot failed') } }`)
      const loaded = await loadApplication(workspace.dir)
      expect(loaded.entry).toBe(join(workspace.dir, 'src/main.ts'))
      expect(loaded.moduleExports.default).toBe(loaded.app)
      await expect(loadBootedApplication(workspace.dir)).rejects.toThrow('boot failed')
    } finally {
      await workspace.cleanup()
    }
  })

  for (const hook of ['ready', 'bootstrap']) {
    it(`does not boot again after the module's ${hook} hook`, async () => {
      const workspace = await createTempWorkspace('guren-runtime-ready-policy-')
      try {
        await mkdir(join(workspace.dir, 'src'), { recursive: true })
        await writeFile(join(workspace.dir, 'src/main.ts'), `
          const app = { listen() {}, boot() { throw new Error('booted twice') } }
          ${hook === 'ready' ? 'export const ready = Promise.resolve(app)' : 'export const bootstrap = async () => app'}
        `)
        expect((await loadBootedApplication(workspace.dir)).listen).toBeTypeOf('function')
      } finally {
        await workspace.cleanup()
      }
    })
  }

  it('imports the first available application module', async () => {
    const workspace = await createTempWorkspace('guren-cli-runtime-import-')
    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'src/main.ts'),
        'export const app = { listen() {} }',
        'utf8',
      )

      const result = await importFirstAvailableApplicationModule(['missing.ts', 'src/main.ts'])
      expect(result?.path.endsWith('src/main.ts')).toBe(true)
      expect(result?.module).toBeDefined()
    } finally {
      await workspace.cleanup()
    }
  })
})
