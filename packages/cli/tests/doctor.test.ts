import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getDoctorRuleEvaluations, runDoctor } from '../src/doctor'
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
        join(workspace.dir, '.guren/data.gen.ts'),
        'export namespace Data {}\n',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.guren/channels.gen.ts'),
        'export type ChannelEvents = Record<string, Record<string, unknown>>\n',
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
      expect(report.fixableChecks).toHaveLength(0)
      expect(report.manualChecks).toHaveLength(0)
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
      expect(report.fixableChecks.some((check) => check.key === 'scripts')).toBe(true)
      expect(report.fixableChecks.some((check) => check.key === 'tsconfig')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('autofixes missing scripts and tsconfig include', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-autofix-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-autofix',
          scripts: {
            dev: 'bun run dev',
          },
        }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(join(workspace.dir, 'src/app.ts'), "export const app = createApp({ routes: [] })\n", 'utf8')
      await writeFile(join(workspace.dir, 'routes/web.ts'), 'export default []\n', 'utf8')
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({
          include: ['src/**/*'],
        }, null, 2),
        'utf8',
      )

      const { evaluations } = await getDoctorRuleEvaluations({ cwd: workspace.dir })
      for (const evaluation of evaluations) {
        if (evaluation.autofix) {
          await evaluation.autofix.apply(workspace.dir)
        }
      }

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const packageJson = JSON.parse(await Bun.file(join(workspace.dir, 'package.json')).text()) as {
        scripts: Record<string, string>
      }
      const tsconfig = JSON.parse(await Bun.file(join(workspace.dir, 'tsconfig.json')).text()) as {
        include: string[]
      }

      expect(packageJson.scripts.build).toBe('bun run codegen && bunx vite build')
      expect(packageJson.scripts.typecheck).toBe('tsc --noEmit')
      expect(packageJson.scripts.codegen).toBe('bunx guren codegen --routes routes/web.ts --out types/generated/routes.d.ts --force')
      expect(tsconfig.include).toContain('.guren/**/*')
      expect(report.fixableChecks.some((check) => check.key === 'scripts')).toBe(false)
      expect(report.fixableChecks.some((check) => check.key === 'tsconfig')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves malformed tsconfig as a manual step', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-tsconfig-error-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-tsconfig-error',
          scripts: {
            dev: 'bun run dev',
            build: 'bun run build',
            typecheck: 'tsc --noEmit',
            codegen: 'bunx guren codegen --force',
          },
        }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(join(workspace.dir, 'src/app.ts'), "export const app = createApp({ routes: [] })\n", 'utf8')
      await writeFile(join(workspace.dir, 'routes/web.ts'), 'export default []\n', 'utf8')
      await writeFile(join(workspace.dir, 'tsconfig.json'), '{\n  "include": [\n', 'utf8')

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const tsconfigCheck = report.manualChecks.find((check) => check.key === 'tsconfig')

      expect(tsconfigCheck?.status).toBe('warn')
      expect(tsconfigCheck?.canAutofix).toBeFalsy()
      expect(tsconfigCheck?.manualFix).toContain('Repair tsconfig.json')
    } finally {
      await workspace.cleanup()
    }
  })
})
