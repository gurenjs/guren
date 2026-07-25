import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { getDoctorRuleEvaluations, runDoctor, buildJsonOutput, suggestNextSteps } from '../src/doctor'
import type { DoctorJsonOutput } from '../src/doctor'
import { createTempWorkspace, writeInstalledPackage } from './helpers'

let consoleLogSpy: ReturnType<typeof spyOn>
const VALID_APP_KEY = 'base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='

beforeEach(() => {
  // Suppress console.log output from --json mode during tests
  consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  consoleLogSpy.mockRestore()
})

describe('runDoctor', () => {
  it('passes for a vNext-style workspace', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-pass-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await mkdir(join(workspace.dir, 'resources/js/pages'), { recursive: true })
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await mkdir(join(workspace.dir, 'config'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-pass',
          scripts: {
            dev: 'bun run dev',
            'dev:server': 'bun --hot bin/serve.ts',
            build: 'bun run build',
            typecheck: 'tsc --noEmit',
            codegen: 'bunx guren codegen --force',
          },
          devDependencies: {
            '@guren/testing': '^1.0.0',
          },
        }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app as default } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nimport { registerWebRoutes } from '@/routes/web'\nimport { DatabaseProvider } from '@guren/orm'\nexport const app = createApp({ routes: registerWebRoutes, providers: [DatabaseProvider] })\n",
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
        join(workspace.dir, '.guren/api-client.gen.ts'),
        'export type ApiRoutes = {}\n',
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
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } },
          include: ['src/**/*', '.guren/**/*'],
        }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.env'),
        `DATABASE_URL=postgres://guren:guren@localhost:54322/guren\nAPP_KEY=${VALID_APP_KEY}\n`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        "import { createPostgresDatabase } from '@guren/orm'\nexport default createPostgresDatabase()\n",
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
      await writeFile(join(workspace.dir, '.env'), `APP_KEY=${VALID_APP_KEY}\n`, 'utf8')

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
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> }
      }

      expect(packageJson.scripts['dev:server']).toBe('bun --hot bin/serve.ts')
      expect(packageJson.scripts.build).toBe('bun run codegen && bunx vite build')
      expect(packageJson.scripts.typecheck).toBe('tsc --noEmit')
      expect(packageJson.scripts.codegen).toBe('bunx guren codegen --routes routes/web.ts --out types/generated/routes.d.ts --force')
      expect(tsconfig.include).toContain('.guren/**/*')
      expect(tsconfig.compilerOptions?.baseUrl).toBe('.')
      expect(tsconfig.compilerOptions?.paths?.['@/*']).toEqual(['./*'])
      expect(report.fixableChecks.some((check) => check.key === 'scripts')).toBe(false)
      expect(report.fixableChecks.some((check) => check.key === 'tsconfig')).toBe(false)
      expect(report.fixableChecks.some((check) => check.key === 'tsconfig-alias')).toBe(false)
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

  it('detects bun version and passes when running under Bun', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-bun-version-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-bun-version' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const bunCheck = report.checks.find((check) => check.key === 'bun-version')

      // Tests run under Bun, so version should be detected and >= 1.1.0
      expect(bunCheck).toBeDefined()
      expect(bunCheck?.status).toBe('pass')
      expect(bunCheck?.message).toContain('Bun')
      expect(bunCheck?.message).toContain('detected')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when .env is missing but .env.example exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-env-warn-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-env-warn' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.env.example'),
        'DATABASE_URL=postgres://user:pass@localhost:5432/dbname\nAPP_KEY=\n',
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const envCheck = report.checks.find((check) => check.key === 'env-file')

      expect(envCheck).toBeDefined()
      expect(envCheck?.status).toBe('warn')
      expect(envCheck?.message).toContain('.env.example')
      expect(envCheck?.canAutofix).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when neither .env nor .env.example exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-env-fail-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-env-fail' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const envCheck = report.checks.find((check) => check.key === 'env-file')

      expect(envCheck).toBeDefined()
      expect(envCheck?.status).toBe('fail')
      expect(envCheck?.message).toContain('Neither .env nor .env.example')
    } finally {
      await workspace.cleanup()
    }
  })

  it('autofixes .env by copying .env.example', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-env-autofix-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-env-autofix' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.env.example'),
        'DATABASE_URL=postgres://user:pass@localhost:5432/dbname\nAPP_KEY=\n',
        'utf8',
      )

      const { evaluations } = await getDoctorRuleEvaluations({ cwd: workspace.dir })
      const envEval = evaluations.find((e) => e.check.key === 'env-file')

      expect(envEval?.autofix).toBeDefined()
      await envEval!.autofix!.apply(workspace.dir)

      const envContent = await Bun.file(join(workspace.dir, '.env')).text()
      expect(envContent).toContain('DATABASE_URL=')

      // Re-run doctor to confirm env-file now passes
      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const envCheck = report.checks.find((check) => check.key === 'env-file')
      expect(envCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes when .env exists for env-file check', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-env-pass-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-env-pass' }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, '.env'), `APP_KEY=${VALID_APP_KEY}\n`, 'utf8')

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const envCheck = report.checks.find((check) => check.key === 'env-file')

      expect(envCheck).toBeDefined()
      expect(envCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when no database config file exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-db-warn-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-db-warn' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const dbCheck = report.checks.find((check) => check.key === 'database-config')

      expect(dbCheck).toBeDefined()
      expect(dbCheck?.status).toBe('warn')
      expect(dbCheck?.message).toContain('No database configuration file found')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when database config exists but DATABASE_URL missing from .env', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-db-no-url-')

    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-db-no-url' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        "import { createPostgresDatabase } from '@guren/orm'\nexport default createPostgresDatabase()\n",
        'utf8',
      )
      await writeFile(join(workspace.dir, '.env'), `APP_KEY=${VALID_APP_KEY}\n`, 'utf8')

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const dbCheck = report.checks.find((check) => check.key === 'database-config')

      expect(dbCheck).toBeDefined()
      expect(dbCheck?.status).toBe('warn')
      expect(dbCheck?.message).toContain('DATABASE_URL')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes when database config and DATABASE_URL both exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-db-pass-')

    try {
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-db-pass' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        "import { createPostgresDatabase } from '@guren/orm'\nexport default createPostgresDatabase()\n",
        'utf8',
      )
      await writeFile(
        join(workspace.dir, '.env'),
        `DATABASE_URL=postgres://guren:guren@localhost:54322/guren\nAPP_KEY=${VALID_APP_KEY}\n`,
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const dbCheck = report.checks.find((check) => check.key === 'database-config')

      expect(dbCheck).toBeDefined()
      expect(dbCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes database-config when db/config.ts exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-db-alt-')

    try {
      await mkdir(join(workspace.dir, 'db'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-db-alt' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'db/config.ts'),
        "export default {}\n",
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const dbCheck = report.checks.find((check) => check.key === 'database-config')

      expect(dbCheck).toBeDefined()
      expect(dbCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects runtime environment as Bun', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-runtime-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-runtime' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const runtimeCheck = report.checks.find((check) => check.key === 'runtime')

      expect(runtimeCheck).toBeDefined()
      expect(runtimeCheck?.status).toBe('pass')
      expect(runtimeCheck?.message).toContain('Bun')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns about missing api-client.gen.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-api-client-')

    try {
      await mkdir(join(workspace.dir, '.guren'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-api-client' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const apiClientCheck = report.checks.find((check) => check.key === 'generated:.guren/api-client.gen.ts')

      expect(apiClientCheck).toBeDefined()
      expect(apiClientCheck?.status).toBe('warn')
      expect(apiClientCheck?.message).toContain('api-client.gen.ts')
      expect(apiClientCheck?.fix).toContain('codegen')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when the @/* alias maps to the app directory instead of the project root', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-alias-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-alias' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: '.', paths: { '@/*': ['./app/*'] } },
          include: ['.guren/**/*'],
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const aliasCheck = report.checks.find((check) => check.key === 'tsconfig-alias')

      expect(aliasCheck?.status).toBe('warn')
      expect(aliasCheck?.message).toContain('./app/*')
      expect(aliasCheck?.fix).toContain('["./*"]')
      expect(aliasCheck?.canAutofix).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('alias autofix preserves existing compilerOptions and path mappings', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-alias-autofix-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-alias-autofix' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, paths: { '#lib/*': ['./lib/*'] } },
          include: ['.guren/**/*'],
        }, null, 2),
        'utf8',
      )

      const { evaluations } = await getDoctorRuleEvaluations({ cwd: workspace.dir })
      const aliasEval = evaluations.find((evaluation) => evaluation.check.key === 'tsconfig-alias')
      expect(aliasEval?.autofix).toBeDefined()
      await aliasEval!.autofix!.apply(workspace.dir)

      const tsconfig = JSON.parse(await Bun.file(join(workspace.dir, 'tsconfig.json')).text()) as {
        compilerOptions: { strict?: boolean; baseUrl?: string; paths?: Record<string, string[]> }
        include: string[]
      }

      expect(tsconfig.compilerOptions.strict).toBe(true)
      expect(tsconfig.compilerOptions.baseUrl).toBe('.')
      expect(tsconfig.compilerOptions.paths?.['#lib/*']).toEqual(['./lib/*'])
      expect(tsconfig.compilerOptions.paths?.['@/*']).toEqual(['./*'])
      expect(tsconfig.include).toEqual(['.guren/**/*'])
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when a custom baseUrl repoints a root @/* mapping', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-alias-baseurl-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-alias-baseurl' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { baseUrl: 'src', paths: { '@/*': ['./*'] } },
          include: ['.guren/**/*'],
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const aliasCheck = report.checks.find((check) => check.key === 'tsconfig-alias')

      expect(aliasCheck?.status).toBe('warn')
      expect(aliasCheck?.message).toContain('baseUrl')
      expect(aliasCheck?.canAutofix).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when the @/* alias is missing entirely', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-alias-missing-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-alias-missing' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tsconfig.json'),
        JSON.stringify({ include: ['.guren/**/*'] }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const aliasCheck = report.checks.find((check) => check.key === 'tsconfig-alias')

      expect(aliasCheck?.status).toBe('warn')
      expect(aliasCheck?.message).toContain('@/*')
      expect(aliasCheck?.canAutofix).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects config drift when routes file exists but not wired', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-drift-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-drift' }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nexport const app = createApp({})\n",
        'utf8',
      )
      await writeFile(join(workspace.dir, 'routes/web.ts'), 'export default []\n', 'utf8')

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const driftCheck = report.checks.find((check) => check.key === 'config-drift')

      expect(driftCheck).toBeDefined()
      expect(driftCheck?.status).toBe('warn')
      expect(driftCheck?.message).toContain('config drift')
      expect(driftCheck?.message).toContain('Route file exists')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes config-drift when routes are properly wired', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-drift-pass-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-drift-pass' }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nimport { registerWebRoutes } from '@/routes/web'\nexport const app = createApp({ routes: registerWebRoutes })\n",
        'utf8',
      )
      await writeFile(join(workspace.dir, 'routes/web.ts'), 'export default []\n', 'utf8')

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const driftCheck = report.checks.find((check) => check.key === 'config-drift')

      expect(driftCheck).toBeDefined()
      expect(driftCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects config drift when providers dir exists but not referenced', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-drift-providers-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Providers'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-drift-providers' }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nexport const app = createApp({ routes: [] })\n",
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Providers/AppProvider.ts'),
        "export class AppProvider {}\n",
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const driftCheck = report.checks.find((check) => check.key === 'config-drift')

      expect(driftCheck).toBeDefined()
      expect(driftCheck?.status).toBe('warn')
      expect(driftCheck?.message).toContain('Providers directory')
    } finally {
      await workspace.cleanup()
    }
  })

  it('produces stable JSON output with version and summary', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-json-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-json' }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nexport const app = createApp({ routes: [] })\n",
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const jsonOutput = buildJsonOutput(report)

      // Verify stable JSON schema
      expect(jsonOutput.version).toBe(1)
      expect(jsonOutput.cwd).toBe(workspace.dir)
      expect(jsonOutput.timestamp).toBeDefined()
      expect(typeof jsonOutput.timestamp).toBe('string')
      expect(jsonOutput.runtime.name).toBe('bun')
      expect(jsonOutput.runtime.version).toBeDefined()

      // Verify summary counts match checks
      expect(jsonOutput.summary.total).toBe(jsonOutput.checks.length)
      expect(
        jsonOutput.summary.pass + jsonOutput.summary.warn + jsonOutput.summary.fail,
      ).toBe(jsonOutput.summary.total)

      // Verify checks have normalized shape (no undefined values)
      for (const check of jsonOutput.checks) {
        expect(check.key).toBeDefined()
        expect(check.title).toBeDefined()
        expect(['pass', 'warn', 'fail']).toContain(check.status)
        expect(typeof check.message).toBe('string')
        expect(check.fix === null || typeof check.fix === 'string').toBe(true)
        expect(typeof check.canAutofix).toBe('boolean')
        expect(check.manualFix === null || typeof check.manualFix === 'string').toBe(true)
      }

      // Verify recommendedCommands
      expect(jsonOutput.recommendedCommands.length).toBeGreaterThan(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('includes nextSteps in JSON output when --next is used', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-json-next-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-json-next' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true, next: true })
      const jsonOutput = buildJsonOutput(report)

      expect(jsonOutput.nextSteps).toBeDefined()
      expect(Array.isArray(jsonOutput.nextSteps)).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects config drift when database config exists but DatabaseProvider missing', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-drift-db-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await mkdir(join(workspace.dir, 'config'), { recursive: true })

      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-drift-db' }, null, 2),
        'utf8',
      )
      await writeFile(join(workspace.dir, 'src/main.ts'), "export { app } from './app'\n", 'utf8')
      await writeFile(
        join(workspace.dir, 'src/app.ts'),
        "import { createApp } from '@guren/core'\nexport const app = createApp({ routes: [] })\n",
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'config/database.ts'),
        "import { createPostgresDatabase } from '@guren/orm'\nexport default createPostgresDatabase()\n",
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const driftCheck = report.checks.find((check) => check.key === 'config-drift')

      expect(driftCheck).toBeDefined()
      expect(driftCheck?.status).toBe('warn')
      expect(driftCheck?.message).toContain('DatabaseProvider')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when an installed plugin is incompatible with the installed core', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-plugin-compat-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-plugin-compat',
          dependencies: {
            '@guren/core': '^1.0.0',
            '@acme/guren-plugin-audit': '^1.0.0',
          },
        }, null, 2),
        'utf8',
      )
      await writeInstalledPackage('@guren/core', { version: '1.2.0' }, {}, workspace.dir)
      await writeInstalledPackage('@acme/guren-plugin-audit', {
        version: '1.0.0',
        gurenPlugin: { compatibility: '>=2.0.0' },
      }, {}, workspace.dir)

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const pluginCheck = report.checks.find((check) => check.key === 'plugin-compatibility')

      expect(pluginCheck).toBeDefined()
      expect(pluginCheck?.status).toBe('warn')
      expect(pluginCheck?.message).toContain('@acme/guren-plugin-audit')
      expect(pluginCheck?.message).toContain('>=2.0.0')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when @guren/testing is absent and no test files exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-warn-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-test-infra-warn' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const testInfraCheck = report.checks.find((check) => check.key === 'test-infrastructure')

      expect(testInfraCheck).toBeDefined()
      expect(testInfraCheck?.status).toBe('warn')
      expect(testInfraCheck?.message).toContain('@guren/testing')
      expect(testInfraCheck?.fix).toContain('bun add -d @guren/testing')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes test-infrastructure when @guren/testing is a devDependency', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-devdep-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-test-infra-devdep',
          devDependencies: { '@guren/testing': '^1.0.0' },
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const testInfraCheck = report.checks.find((check) => check.key === 'test-infrastructure')

      expect(testInfraCheck).toBeDefined()
      expect(testInfraCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes test-infrastructure when @guren/testing is a regular dependency', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-dep-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-test-infra-dep',
          dependencies: { '@guren/testing': '^1.0.0' },
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const testInfraCheck = report.checks.find((check) => check.key === 'test-infrastructure')

      expect(testInfraCheck).toBeDefined()
      expect(testInfraCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes test-infrastructure when test files exist even without @guren/testing', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-files-')

    try {
      await mkdir(join(workspace.dir, 'tests/controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-test-infra-files' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'tests/controllers/PostController.test.ts'),
        "import { test, expect } from 'bun:test'\ntest('placeholder', () => { expect(true).toBe(true) })\n",
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const testInfraCheck = report.checks.find((check) => check.key === 'test-infrastructure')

      expect(testInfraCheck).toBeDefined()
      expect(testInfraCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes test-infrastructure when tests are colocated next to source, outside tests/', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-colocated-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-test-infra-colocated' }, null, 2),
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Models/Post.test.ts'),
        "import { test, expect } from 'bun:test'\ntest('placeholder', () => { expect(true).toBe(true) })\n",
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const testInfraCheck = report.checks.find((check) => check.key === 'test-infrastructure')

      expect(testInfraCheck).toBeDefined()
      expect(testInfraCheck?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not treat non-test files under tests/ as test infrastructure', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-nontest-')

    try {
      await mkdir(join(workspace.dir, 'tests'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-test-infra-nontest' }, null, 2),
        'utf8',
      )
      // A helper file, not a *.test.ts file — should not count as test infrastructure.
      await writeFile(join(workspace.dir, 'tests/helpers.ts'), 'export const noop = () => {}\n', 'utf8')

      const report = await runDoctor({ cwd: workspace.dir, json: true })
      const testInfraCheck = report.checks.find((check) => check.key === 'test-infrastructure')

      expect(testInfraCheck).toBeDefined()
      expect(testInfraCheck?.status).toBe('warn')
    } finally {
      await workspace.cleanup()
    }
  })

  it('surfaces missing test infrastructure as a --next actionable step', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-next-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({ name: 'doctor-test-infra-next' }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true, next: true })

      expect(report.nextSteps).toBeDefined()
      expect(
        report.nextSteps?.some((step) => step.command === 'bun add -d @guren/testing'),
      ).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not suggest installing test infrastructure in --next when already present', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-test-infra-next-absent-')

    try {
      await writeFile(
        join(workspace.dir, 'package.json'),
        JSON.stringify({
          name: 'doctor-test-infra-next-absent',
          devDependencies: { '@guren/testing': '^1.0.0' },
        }, null, 2),
        'utf8',
      )

      const report = await runDoctor({ cwd: workspace.dir, json: true, next: true })

      expect(
        report.nextSteps?.some((step) => step.command === 'bun add -d @guren/testing'),
      ).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('suggestNextSteps', () => {
  it('does not suggest tests for a controller with a co-located test', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-colocated-test-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers/Auth'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'),
        `export default class OAuthController {\n  async callback() { return null }\n}`,
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.test.ts'),
        `test('callback', () => {})`,
        'utf8',
      )

      const steps = await suggestNextSteps({ cwd: workspace.dir })

      expect(steps.some((step) => step.title.includes('OAuthController'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('suggests make:test with --module for a module controller missing a test', async () => {
    const workspace = await createTempWorkspace('guren-cli-doctor-module-test-')

    try {
      await mkdir(join(workspace.dir, 'modules/blog/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/PostsController.ts'),
        `export default class PostsController {\n  async index() { return null }\n}`,
        'utf8',
      )
      // A test file next to the controller must not be reported as a
      // controller of its own.
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/PostsController.test.ts'),
        `test('index', () => {})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'modules/blog/app/Http/Controllers/Auth'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/Auth/OAuthController.ts'),
        `export default class OAuthController {\n  async callback() { return null }\n}`,
        'utf8',
      )

      const steps = await suggestNextSteps({ cwd: workspace.dir })

      expect(steps.some((step) => step.title.includes('.test'))).toBe(false)
      expect(steps.some((step) => step.title === 'Add tests for PostsController')).toBe(false)

      const oauthStep = steps.find((step) => step.title === 'Add tests for OAuthController')
      expect(oauthStep).toBeDefined()
      expect(oauthStep!.command).toBe('bunx guren make:test OAuth --controller --module blog')
    } finally {
      await workspace.cleanup()
    }
  })
})
