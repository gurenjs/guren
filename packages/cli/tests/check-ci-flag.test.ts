import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createTempWorkspace, runCliBin as runBin } from './helpers'

/**
 * In a real app `guren codegen` runs before `check --ci` (that is the
 * scaffolded workflow order); stub its manifests so fixtures match that
 * state instead of warning about missing generated files.
 */
async function writeCodegenManifests(dir: string): Promise<void> {
  await mkdir(join(dir, '.guren'), { recursive: true })
  for (const manifest of ['routes.gen.ts', 'pages.gen.ts', 'data.gen.ts']) {
    await writeFile(join(dir, '.guren', manifest), 'export {}\n', 'utf8')
  }
}

/** A controller with no matching test file: `check` reports it as a warn. */
async function writeUntestedController(dir: string): Promise<void> {
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await writeFile(
    join(dir, 'app/Http/Controllers/WidgetController.ts'),
    `export default class WidgetController {
  async index() {
    return { widgets: [] }
  }
}`,
    'utf8',
  )
}

describe('check --ci exit gating', () => {
  it('plain check never sets an exit code; --ci gates on integrity warns', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-ci-')

    try {
      // Routes exist but no codegen manifests: an integrity warn.
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'routes/web.ts'),
        `export default function registerRoutes(router: any) {
  router.get('/health', (c: any) => c.json({ status: 'ok' }))
}`,
        'utf8',
      )

      // The stable v1.0 contract: findings alone never fail a plain check.
      expect(await runBin(['check'], workspace.dir)).toBe(0)
      // The opt-in gate fails on integrity warns — most integrity problems
      // report as 'warn', so a fail-only gate would wave nearly everything
      // through.
      expect(await runBin(['check', '--ci'], workspace.dir)).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('--ci does not gate on test-coverage nudges', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-ci-coverage-')

    try {
      await writeUntestedController(workspace.dir)
      await writeCodegenManifests(workspace.dir)

      // The missing-test warn is advice, not an integrity failure —
      // scaffolding a controller must not turn CI red until a test exists.
      expect(await runBin(['check', '--ci'], workspace.dir)).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('--ci passes on a clean workspace', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-ci-clean-')

    try {
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'routes/web.ts'),
        `export default function registerRoutes(router: any) {
  router.get('/health', (c: any) => c.json({ status: 'ok' }))
}`,
        'utf8',
      )
      await writeCodegenManifests(workspace.dir)

      expect(await runBin(['check', '--ci'], workspace.dir)).toBe(0)
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('check --ci flag combinations', () => {
  it('refuses suite flags so a narrowed run cannot pose as the full gate', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-ci-suite-')

    try {
      await writeCodegenManifests(workspace.dir)

      // Even a workspace with nothing to report exits 1 — the failure is
      // the flag combination itself, not a finding.
      expect(await runBin(['check', '--ci', '--docs'], workspace.dir)).toBe(1)
    } finally {
      await workspace.cleanup()
    }
  })
})
