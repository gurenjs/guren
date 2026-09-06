import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reportDeployRuntimeHazards } from './deploy-check'

const SESSION_APP = `import { createApp } from '@guren/core'
export default createApp({ auth: { autoSession: true } })
`

function writeApp(root: string, dependencies: Record<string, string>): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/app.ts'), SESSION_APP)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo-app', dependencies }))
}

/** Everything a run wrote to `console.warn`. */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (message: string) => warnings.push(message)
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings
}

describe('reportDeployRuntimeHazards', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-deploy-check-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test('should warn once per failing verdict, prefixed with the build label', async () => {
    writeApp(root, { '@guren/plugin-cloudflare': '^0.2.0' })

    let lines: string[] = []
    const warnings = await captureWarnings(async () => {
      lines = await reportDeployRuntimeHazards({ root, label: 'Cloudflare build' })
    })

    expect(lines).toEqual(warnings)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toStartWith('Cloudflare build: Cloudflare Workers shares no memory')
    expect(lines[0]).toContain('sessions are enabled')
    expect(lines[0]).toContain('DatabaseSessionStore')
  })

  test('should print nothing for an app with no deploy target', async () => {
    writeApp(root, {})

    let lines: string[] = ['unset']
    const warnings = await captureWarnings(async () => {
      lines = await reportDeployRuntimeHazards({ root, label: 'Cloudflare build' })
    })

    expect(lines).toEqual([])
    expect(warnings).toEqual([])
  })

  test('should print nothing when every verdict passes', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'src/app.ts'),
      `import { createApp, DatabaseSessionStore } from '@guren/core'
export default createApp({ auth: { sessionOptions: { store: new DatabaseSessionStore({}) } } })
`,
    )
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'demo-app', dependencies: { '@guren/plugin-cloudflare': '^0.2.0' } }),
    )

    const warnings = await captureWarnings(async () => {
      expect(await reportDeployRuntimeHazards({ root, label: 'Cloudflare build' })).toEqual([])
    })

    expect(warnings).toEqual([])
  })
})
