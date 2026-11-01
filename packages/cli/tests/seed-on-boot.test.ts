import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { hasLegacySeedOnBoot, rewriteLegacySeedOnBoot, SEED_ON_BOOT_EXPRESSION, withDevelopmentNodeEnv } from '../src/seed-on-boot'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const LEGACY_CONFIG = `import { defineDatabaseConfig } from '@guren/core'
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
`

describe('seed-on-boot rewrite', () => {
  it('rewrites the denylist form, in either quote style, to the allowlist', () => {
    expect(hasLegacySeedOnBoot(LEGACY_CONFIG)).toBe(true)
    expect(rewriteLegacySeedOnBoot(LEGACY_CONFIG)).toContain(`{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`)
    expect(rewriteLegacySeedOnBoot('{ seedOnBoot: process.env.NODE_ENV != "production" }')).toBe(`{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`)
    expect(hasLegacySeedOnBoot(rewriteLegacySeedOnBoot(LEGACY_CONFIG))).toBe(false)
  })

  it('leaves a seedOnBoot the author wrote some other way alone', () => {
    const custom = "{ seedOnBoot: process.env.SEED === '1' }"
    expect(hasLegacySeedOnBoot(custom)).toBe(false)
    expect(rewriteLegacySeedOnBoot(custom)).toBe(custom)
  })

  it('prefixes only a bare `bun --hot` serve script', () => {
    expect(withDevelopmentNodeEnv('bun --hot bin/serve.ts')).toBe('NODE_ENV=development bun --hot bin/serve.ts')
    expect(withDevelopmentNodeEnv('NODE_ENV=staging bun --hot bin/serve.ts')).toBeNull()
    expect(withDevelopmentNodeEnv('bun run codegen && bun run dev:server')).toBeNull()
  })
})

describe('doctor seed-on-boot rule', () => {
  it('warns on the denylist form and its autofix rewrites the config and the dev script', async () => {
    const workspace = await createTempWorkspace('guren-doctor-seed-on-boot-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': JSON.stringify({ name: 'seed', scripts: { dev: 'bun run codegen && bun run dev:server', 'dev:server': 'bun --hot bin/serve.ts' } }, null, 2),
        'config/database.ts': LEGACY_CONFIG,
      })

      const { evaluations } = await getDoctorRuleEvaluations({ cwd: workspace.dir })
      const evaluation = evaluations.find((entry) => entry.check.key === 'seed-on-boot')
      expect(evaluation?.check.status).toBe('warn')
      await evaluation?.autofix?.apply(workspace.dir)

      const config = await readFile(join(workspace.dir, 'config/database.ts'), 'utf8')
      const scripts = (JSON.parse(await readFile(join(workspace.dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
      expect(config).toContain(SEED_ON_BOOT_EXPRESSION)
      expect(scripts['dev:server']).toBe('NODE_ENV=development bun --hot bin/serve.ts')
      expect(scripts.dev).toBe('bun run codegen && bun run dev:server')

      const rerun = await getDoctorRuleEvaluations({ cwd: workspace.dir })
      expect(rerun.evaluations.find((entry) => entry.check.key === 'seed-on-boot')?.check.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })
})
