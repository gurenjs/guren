import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { planSeedOnBootUpgrade, SEED_ON_BOOT_EXPRESSION, type SeedOnBootPlan } from '../src/seed-on-boot'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const LEGACY_CONFIG = `import { defineDatabaseConfig } from '@guren/core'
export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
`
const DEV_SCRIPTS = { dev: 'bun run codegen && bun run dev:server', 'dev:server': 'bun --hot bin/serve.ts' }

function rewritten(plan: SeedOnBootPlan): Extract<SeedOnBootPlan, { kind: 'rewrite' }> {
  if (plan.kind !== 'rewrite') throw new Error(`expected a rewrite, got ${JSON.stringify(plan)}`)
  return plan
}

describe('planSeedOnBootUpgrade config', () => {
  it('rewrites the whole denylist value, in either quote style, to the allowlist', () => {
    expect(rewritten(planSeedOnBootUpgrade(LEGACY_CONFIG, DEV_SCRIPTS)).config).toContain(`{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`)
    const multiline = 'defineDatabaseConfig(database, {\n  seedOnBoot: process.env.NODE_ENV != "production"\n})\n'
    expect(rewritten(planSeedOnBootUpgrade(multiline, DEV_SCRIPTS)).config).toBe(`defineDatabaseConfig(database, {\n  seedOnBoot: ${SEED_ON_BOOT_EXPRESSION}\n})\n`)
  })

  it('leaves a value that goes on past the comparison to the manual fix', () => {
    const optOut = "defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' && process.env.SEED !== '0' })"
    const method = "defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production'.trim() })"
    expect(planSeedOnBootUpgrade(optOut, DEV_SCRIPTS).kind).toBe('manual')
    expect(planSeedOnBootUpgrade(method, DEV_SCRIPTS).kind).toBe('manual')
  })

  it('ignores a commented-out expression and one the author wrote another way', () => {
    const commented = "// seedOnBoot: process.env.NODE_ENV !== 'production',\ndefineDatabaseConfig(database, { seedOnBoot: process.env.SEED === '1' })\n"
    expect(planSeedOnBootUpgrade(commented, DEV_SCRIPTS)).toEqual({ kind: 'none' })
  })
})

describe('planSeedOnBootUpgrade dev script', () => {
  it('prefixes the single-command script that starts serve.ts', () => {
    expect(rewritten(planSeedOnBootUpgrade(LEGACY_CONFIG, DEV_SCRIPTS)).script).toEqual({ name: 'dev:server', command: 'NODE_ENV=development bun --hot bin/serve.ts' })
    for (const command of ['bun bin/serve.ts', 'GUREN_MCP=1 bun --hot bin/serve.ts', 'bun --hot --inspect bin/serve.ts']) {
      expect(rewritten(planSeedOnBootUpgrade(LEGACY_CONFIG, { dev: command })).script).toEqual({ name: 'dev', command: `NODE_ENV=development ${command}` })
    }
  })

  it('rewrites only the config when a dev script already sets NODE_ENV=development', () => {
    expect(rewritten(planSeedOnBootUpgrade(LEGACY_CONFIG, { 'dev:server': 'NODE_ENV=development bun --hot bin/serve.ts' })).script).toBeNull()
    expect(rewritten(planSeedOnBootUpgrade(LEGACY_CONFIG, { dev: 'bunx guren dev' })).script).toBeNull()
  })

  it('writes nothing when no dev script can be made to seed', () => {
    for (const scripts of [undefined, { dev: 'bun run codegen && bun bin/serve.ts' }, { dev: 'NODE_ENV=staging bun bin/serve.ts' }, { dev: 'vite' }]) {
      expect(planSeedOnBootUpgrade(LEGACY_CONFIG, scripts).kind).toBe('manual')
    }
  })
})

async function seedOnBootEvaluation(dir: string) {
  const { evaluations } = await getDoctorRuleEvaluations({ cwd: dir })
  return evaluations.find((entry) => entry.check.key === 'seed-on-boot')
}

describe('doctor seed-on-boot rule', () => {
  it('warns on the denylist form and its autofix rewrites the config and the dev script', async () => {
    const workspace = await createTempWorkspace('guren-doctor-seed-on-boot-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': JSON.stringify({ name: 'seed', scripts: DEV_SCRIPTS }, null, 2),
        'config/database.ts': LEGACY_CONFIG,
      })

      const evaluation = await seedOnBootEvaluation(workspace.dir)
      expect(evaluation?.check.status).toBe('warn')
      expect(evaluation?.autofix?.summary).toContain('prefix the `dev:server` script')
      await evaluation?.autofix?.apply(workspace.dir)

      const config = await readFile(join(workspace.dir, 'config/database.ts'), 'utf8')
      const scripts = (JSON.parse(await readFile(join(workspace.dir, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
      expect(config).toContain(SEED_ON_BOOT_EXPRESSION)
      expect(scripts).toEqual({ ...DEV_SCRIPTS, 'dev:server': 'NODE_ENV=development bun --hot bin/serve.ts' })
      expect((await seedOnBootEvaluation(workspace.dir))?.check.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns without an autofix when the dev script cannot be prefixed', async () => {
    const workspace = await createTempWorkspace('guren-doctor-seed-on-boot-manual-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': JSON.stringify({ name: 'seed', scripts: { dev: 'bun run codegen && bun bin/serve.ts' } }, null, 2),
        'config/database.ts': LEGACY_CONFIG,
      })

      const evaluation = await seedOnBootEvaluation(workspace.dir)
      expect(evaluation?.check.status).toBe('warn')
      expect(evaluation?.check.canAutofix).toBe(false)
      expect(evaluation?.autofix ?? null).toBeNull()
      expect(await readFile(join(workspace.dir, 'config/database.ts'), 'utf8')).toBe(LEGACY_CONFIG)
    } finally {
      await workspace.cleanup()
    }
  })
})
