import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  collectManifestViolations,
  collectSourceFiles,
  collectSourceViolations,
  invokesRegistryGuren,
  tokensInvokeRegistryGuren,
} from './workspace-scripts-audit'

const repoRoot = join(import.meta.dir, '..', '..')

function problems(source: string): string[] {
  return collectSourceViolations('x.ts', source).map((v) => `${v.where} ${v.problem}`)
}

describe('registry runner detection', () => {
  test.each([
    'bunx guren codegen',
    'bunx --bun guren check',
    'bun x guren codegen --force',
    'npx guren doctor',
    'pnpm dlx guren@canary upgrade',
    'cd app && bunx guren codegen',
  ])('flags %p', (command) => {
    expect(invokesRegistryGuren(command)).toBe(true)
  })

  test.each([
    'bun ../../packages/cli/src/bin.ts codegen',
    'guren codegen',
    'bun run codegen',
    'bunx tsc --noEmit',
  ])('passes %p', (command) => {
    expect(invokesRegistryGuren(command)).toBe(false)
  })

  test('compares argv elements whole, so a mention holding the phrase is not an invocation', () => {
    // Spelled through split() rather than as an array literal: this file is
    // inside the gate's own scope, and a literal argv here would be flagged.
    expect(tokensInvokeRegistryGuren('bunx guren codegen'.split(' '))).toBe(true)
    expect(tokensInvokeRegistryGuren(['bunx guren add auth', 'bunx guren add storage'])).toBe(false)
  })
})

describe('the source scan, by spawn shape', () => {
  test('flags the argv array the upgrade smoke used to spawn', () => {
    const found = problems(`await run(['bunx', 'guren', 'codegen', '--force'], appDir)\n`)
    expect(found).toEqual(['1:11 argv array resolves `guren` from the registry: bunx guren codegen --force'])
  })

  test('flags the same argv inside Bun.spawn({ cmd }) and with runner flags', () => {
    expect(problems(`Bun.spawn({ cmd: ['bunx', '--bun', 'guren', 'check'], cwd })`)).toHaveLength(1)
    expect(problems(`Bun.spawnSync(['bun', 'x', 'guren', 'codegen'])`)).toHaveLength(1)
  })

  test('flags a Bun shell template and exec-style calls', () => {
    expect(problems('await $`bunx guren codegen --force`.cwd(dir)')).toEqual([
      '1:7 shell template resolves `guren` from the registry: bunx guren codegen --force',
    ])
    expect(problems('await Bun.$`cd ${dir} && npx guren doctor`')).toHaveLength(1)
    expect(problems("execSync('bunx guren codegen', { cwd })")).toHaveLength(1)
    expect(problems("spawnSync('bunx', ['guren', 'codegen'], { cwd })")).toHaveLength(1)
    expect(problems("execFile('npx', ['guren'], cb)")).toHaveLength(1)
  })

  test('passes the sanctioned replacement', () => {
    expect(
      problems(`await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir)\n`),
    ).toEqual([])
  })

  test('leaves mentions alone: docs assertions, checker fixtures, and lists of documented commands', () => {
    expect(problems("assert(readme.includes('bunx guren add auth'), 'README must document it.')")).toEqual([])
    expect(problems("const md = 'Run `bunx guren agent:init --target codex` now.'")).toEqual([])
    expect(problems("const documented = ['bunx guren add auth', 'bunx guren add storage']")).toEqual([])
    expect(problems('const text = `bunx guren codegen` // not tagged, not a shell')).toEqual([])
  })

  test('does not read a dynamic first element as a runner', () => {
    expect(problems(`Bun.spawn([process.execPath, 'x', 'guren'])`)).toEqual([])
  })

  test('throws on a source it cannot parse rather than passing it silently', () => {
    expect(() => problems('const a = ;')).toThrow()
  })
})

describe('manifest scan', () => {
  test('still flags a script and a CLI path that does not resolve', () => {
    const found = collectManifestViolations('packages/x/package.json', {
      scripts: { codegen: 'bunx guren codegen', check: 'bun ./nope/packages/cli/src/bin.ts check' },
    })
    expect(found.map((v) => v.where)).toEqual(['"codegen"', '"check"'])
  })
})

describe('the scope the gate actually covers', () => {
  test('the scripts/ glob reaches the smokes, including the file this gate exists for', async () => {
    const files = await collectSourceFiles()
    expect(files).toContain('scripts/smoke/upgrade-existing-app.ts')
    expect(files).toContain('scripts/smoke/fresh-app.ts')
    expect(files).toContain('scripts/smoke/workspace-scripts-audit.test.ts')
  })

  test('every scripts/ source spawns the CLI locally', async () => {
    const violations = []
    for (const file of await collectSourceFiles()) {
      violations.push(...collectSourceViolations(file, await readFile(join(repoRoot, file), 'utf8')))
    }
    expect(violations).toEqual([])
  })
})
