import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkDeployRuntime } from '@guren/cli'
import { reportDeployRuntimeHazards } from './deploy-check'

const SESSION_APP = `import { createApp } from '@guren/core'
export default createApp({ auth: { autoSession: true } })
`

function writeApp(root: string, dependencies: Record<string, string>): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/app.ts'), SESSION_APP)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo-app', dependencies }))
}

/** An app the CLI can introspect: an entry, and this workspace's @guren/core to import. */
function writeIntrospectableApp(root: string, app: string): void {
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules/@guren'), { recursive: true })
  symlinkSync(resolve(import.meta.dir, '../..'), join(root, 'node_modules/@guren/core'), 'dir')
  writeFileSync(join(root, 'bunfig.toml'), '[install]\nauto = "disable"\n')
  writeFileSync(join(root, 'src/main.ts'), "import app from './app.js'\nexport default app\n")
  writeFileSync(join(root, 'src/app.ts'), app)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-app', type: 'module', dependencies: { '@guren/plugin-cloudflare': '^0.2.0' } }),
  )
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
    const logged: string[] = []
    const log = console.log
    console.log = (message: string) => logged.push(message)
    let warnings: string[]
    try {
      warnings = await captureWarnings(async () => {
        lines = await reportDeployRuntimeHazards({ root, label: 'Cloudflare build' })
      })
    } finally {
      console.log = log
    }

    // No entry to introspect, so the hasher and the stores are unverified rather than read from source.
    expect(lines).toEqual(warnings)
    expect(lines).toHaveLength(2)
    expect(logged.join('\n')).toContain('Deploy Runtime Stores from nothing verifiable, Deploy Provider Discovery from source (introspection failed with no-entry: Could not locate')
    expect(lines[1]).toStartWith('Cloudflare build: Cloudflare Workers shares no memory')
    expect(lines[1]).toContain('unverified: introspection failed with no-entry')
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
    writeIntrospectableApp(
      root,
      `import { createApp, DatabaseSessionStore } from '@guren/core'
export default createApp({ auth: { sessionOptions: { store: new DatabaseSessionStore({} as never) } } })
`,
    )

    const warnings = await captureWarnings(async () => {
      expect(await reportDeployRuntimeHazards({ root, label: 'Cloudflare build' })).toEqual([])
    })

    expect(warnings).toEqual([])
  })

  test('should name the evidence, then report what the introspected app registers, as checkDeployRuntime() does', async () => {
    writeIntrospectableApp(root, "import { createApp } from '@guren/core'\nexport default createApp({ auth: { hasher: 'argon2' } })\n")

    let lines: string[] = []
    const logged: string[] = []
    const log = console.log
    console.log = (message: string) => logged.push(message)
    try {
      await captureWarnings(async () => {
        lines = await reportDeployRuntimeHazards({ root, label: 'Cloudflare build' })
      })
    } finally {
      console.log = log
    }

    expect(logged).toEqual([
      'Cloudflare build: deploy-runtime checks judged Deploy Password Hashing from the introspected app, Deploy Runtime Stores from the introspected app, Deploy Provider Discovery from source.',
    ])
    const expected = (await checkDeployRuntime(root))
      .filter((verdict) => verdict.status !== 'pass')
      .map((verdict) => `Cloudflare build: ${verdict.message}${verdict.fix ? ` ${verdict.fix}` : ''}`)
    expect(lines).toEqual(expected)
    expect(lines.some((line) => line.includes('a Bun-only hasher is registered (createApp({ auth }): DefaultHasher (argon2))'))).toBe(true)
  })
})
