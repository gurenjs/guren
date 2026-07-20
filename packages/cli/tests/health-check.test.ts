import { describe, expect, it, mock } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'

// Bun runs all test files in one shared process, and mock.module()
// replacements are not undone by mock.restore() — a mock missing an export
// silently breaks any other test file that needs the real one. Mirror
// consola's full export surface.
const consolaStub = {
  info: mock(() => {}),
  success: mock(() => {}),
  debug: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  log: mock(() => {}),
}

await mock.module('consola', () => ({
  consola: consolaStub,
  default: consolaStub,
  createConsola: () => consolaStub,
  LogLevels: {},
}))

const { runHealthCheck } = await import('../src/health-check')

describe('runHealthCheck', () => {
  it('prints a basic report when no health manager is configured', async () => {
    const workspace = await createTempWorkspace('guren-cli-health-basic-')
    const logSpy = mock(() => {})
    const originalLog = console.log
    console.log = logSpy as typeof console.log

    try {
      await runHealthCheck({ appRoot: workspace.dir, json: true })
      expect(logSpy).toHaveBeenCalled()
    } finally {
      console.log = originalLog
      await workspace.cleanup()
    }
  })

  it('uses configured health checks when available', async () => {
    const workspace = await createTempWorkspace('guren-cli-health-config-')
    const logSpy = mock(() => {})
    const originalLog = console.log
    console.log = logSpy as typeof console.log

    try {
      await mkdir(join(workspace.dir, 'app'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/health.ts'),
        `
export const health = {
  async check() {
    return { status: 'healthy', timestamp: new Date(), checks: [] }
  },
  async checkOnly(names) {
    globalThis.__healthChecks = names
    return { status: 'healthy', timestamp: new Date(), checks: [] }
  },
  getCheckNames() {
    return ['db', 'cache']
  },
}
`,
        'utf8',
      )

      await runHealthCheck({ appRoot: workspace.dir, checks: 'db,cache', json: true })

      expect((globalThis as typeof globalThis & { __healthChecks?: string[] }).__healthChecks).toEqual(['db', 'cache'])
    } finally {
      delete (globalThis as typeof globalThis & { __healthChecks?: string[] }).__healthChecks
      console.log = originalLog
      await workspace.cleanup()
    }
  })
})
