import { describe, expect, it } from 'bun:test'
import { getDoctorRuleEvaluations } from '../src/doctor'
import { findLegacySeedOnBoot, SEED_ON_BOOT_EXPRESSION } from '../src/seed-on-boot'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const FILE = 'config/database.ts'
const config = (options: string) => `import { defineDatabaseConfig } from '@guren/core'\nexport default defineDatabaseConfig(database, ${options})\n`

describe('findLegacySeedOnBoot', () => {
  it('finds the denylist comparison on one line, in either quote style and operator', () => {
    expect(findLegacySeedOnBoot(config("{ seedOnBoot: process.env.NODE_ENV !== 'production' }"), FILE)).toEqual([2])
    expect(findLegacySeedOnBoot(config('{ seedOnBoot: process.env.NODE_ENV != "production" }'), FILE)).toEqual([2])
  })

  it('finds it as an operand of a logical expression, a leading-operator continuation included', () => {
    const continued = config("{\n  seedOnBoot: process.env.NODE_ENV !== 'production'\n    && process.env.SEED !== '0',\n}")
    expect(findLegacySeedOnBoot(continued, FILE)).toEqual([3])
  })

  it('reads through block and trailing comments, a split key and CRLF', () => {
    const commented = config("{\n  /* seeds locally\n     only */\n  seedOnBoot: process.env.NODE_ENV !== 'production', // demo data\n}")
    const split = config("{\n  seedOnBoot:\n    process.env.NODE_ENV\n    !== 'production',\n}").replaceAll('\n', '\r\n')
    expect(findLegacySeedOnBoot(commented, FILE)).toEqual([5])
    expect(findLegacySeedOnBoot(split, FILE)).toEqual([3])
  })

  it('passes the allowlist, a commented-out comparison, and another seedOnBoot', () => {
    expect(findLegacySeedOnBoot(config(`{ seedOnBoot: ${SEED_ON_BOOT_EXPRESSION} }`), FILE)).toEqual([])
    expect(findLegacySeedOnBoot(config("{\n  // seedOnBoot: process.env.NODE_ENV !== 'production',\n  seedOnBoot: false,\n}"), FILE)).toEqual([])
    expect(findLegacySeedOnBoot("export const x = { seedOnBoot: process.env.NODE_ENV !== 'production' }\n", FILE)).toEqual([])
  })

  it('answers null for a file that does not parse', () => {
    expect(findLegacySeedOnBoot('export default defineDatabaseConfig(', FILE)).toBeNull()
  })
})

describe('doctor seed-on-boot rule', () => {
  it('warns on the denylist form with the manual fix and offers no autofix', async () => {
    const workspace = await createTempWorkspace('guren-doctor-seed-on-boot-')
    try {
      await writeWorkspaceFiles(workspace.dir, {
        'package.json': JSON.stringify({ name: 'seed', scripts: { 'dev:server': 'bun --hot bin/serve.ts' } }),
        [FILE]: config("{ seedOnBoot: process.env.NODE_ENV !== 'production' }"),
      })

      const { evaluations } = await getDoctorRuleEvaluations({ cwd: workspace.dir })
      const evaluation = evaluations.find((entry) => entry.check.key === 'seed-on-boot')
      expect(evaluation?.check.status).toBe('warn')
      expect(evaluation?.check.manualFix).toContain(`(${SEED_ON_BOOT_EXPRESSION})`)
      expect(evaluation?.check.manualFix).toContain('NODE_ENV=development')
      expect(evaluation?.autofix ?? null).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })
})
