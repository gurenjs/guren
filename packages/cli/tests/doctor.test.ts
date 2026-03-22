import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runDoctor } from '../src/doctor'
import { createTempWorkspace } from './helpers'

describe('runDoctor', () => {
  it('passes for a vNext-style workspace', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-pass-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-pass',
          scripts: {
            dev: 'bun run dev',
            build: 'bun run build',
            typecheck: 'tsc --noEmit',
            codegen: 'bunx guren codegen --force',
          },
        }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app as default } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nexport const app = createApp({ routes: [] })\n",
        'utf8',
      )
      await writeFile(join(workspace.dir, 'routes/web.ts'), 'export default []\n', 'utf8')
      await writeFile(
        join(workspace.dir, 'resources/js/pages/contracts.ts'),
        "import { definePage } from '@guren/inertia-client'\nexport const HomePage = definePage('Home')\n",
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.guren/routes.gen.ts'),
        'export const routeManifest = {} as const\n',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.guren/pages.gen.ts'),
        'export const pageManifest = {} as const\n',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({
          include: ['src/**/*', '.guren/**/*'],
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })

      expect(report.hasFailures).toBe(false)
      expect(report.hasWarnings).toBe(false)
      expect(report.checks.every((check) => check.status === 'pass')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about legacy bootstrap and missing codegen artifacts', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-warn-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-warn',
          scripts: {
            dev: 'bun run dev',
          },
        }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'src/main.ts'),
        "import { Application } from '@guren/server'\nexport default new Application()\n",
        'utf8',
      )
      await writeFile(join(workspace.dir, 'routes/web.ts'), 'export default []\n', 'utf8')
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({
          include: ['src/**/*'],
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })

      expect(report.hasFailures).toBe(false)
      expect(report.hasWarnings).toBe(true)
      expect(report.checks.some((check) => check.key === 'bootstrap' && check.status === 'warn')).toBe(true)
      expect(report.checks.some((check) => check.key === 'generated:.guren/routes.gen.ts' && check.status === 'warn')).toBe(true)
      expect(report.checks.some((check) => check.key === 'tsconfig' && check.status === 'warn')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })
})
