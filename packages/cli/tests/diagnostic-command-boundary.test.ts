import { describe, expect, it } from 'bun:test'
import { rm } from 'node:fs/promises'
import { createTempRoot, runCliBinCaptured, writeWorkspaceFiles } from './helpers'

async function invoke(args: string[], files: Record<string, string> = {}) {
  const cwd = await createTempRoot('guren-diagnostic-boundary-')
  try {
    await writeWorkspaceFiles(cwd, files)
    return await runCliBinCaptured(args, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

const unsafeController = {
  'app/Http/Controllers/PostController.ts': `export default class PostController {
    async store() { const data = await this.request.json(); return data }
  }`,
  'routes/web.ts': `class PostController { async store() { return null } }
    export default function registerRoutes(router: any) {
      router.post('/posts', [PostController, 'store'])
    }`,
}

describe('diagnostic command boundary', () => {
  it('audit reports warnings as JSON without failing when there are no failures', async () => {
    const result = await invoke(['audit', '--no-deps', '--json'])
    const report = JSON.parse(result.stdout)
    expect(report.failCount).toBe(0)
    expect(report.warnCount).toBeGreaterThan(0)
    expect(result.exitCode).toBe(0)
  })

  it('audit fails for a validation finding and keeps its JSON report', async () => {
    const result = await invoke(['audit', '--no-deps', '--json'], unsafeController)
    const report = JSON.parse(result.stdout)
    expect(report.findings).toContainEqual(expect.objectContaining({ key: 'validation:POST /posts', status: 'fail' }))
    expect(result.exitCode).toBe(1)
  })

  it('audit renders the same failure in text mode', async () => {
    const result = await invoke(['audit', '--no-deps'], unsafeController)
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain('/posts')
    expect(result.stdout + result.stderr).not.toContain('"findings":')
  })

  it('gate fails when verification stages cannot run and returns its JSON report', async () => {
    const result = await invoke(['gate', '--json'])
    const report = JSON.parse(result.stdout)
    expect(report.ok).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('gate renders an unsuccessful report in text mode', async () => {
    const result = await invoke(['gate'])
    expect(result.exitCode).toBe(1)
    expect(result.stdout + result.stderr).toContain('Gate failed')
    expect(result.stdout + result.stderr).not.toContain('"stages":')
  })
})
