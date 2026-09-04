import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  collectManifestViolations,
  collectShellViolations,
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
    expect(tokensInvokeRegistryGuren(['bunx guren add auth', 'bunx guren add storage'])).toBe(false)
  })
})

describe('the source scan, by spawn shape', () => {
  test.each([
    // argv arrays, whatever consumes them
    `await run(['bunx', 'guren', 'codegen'], appDir)`,
    `Bun.spawn({ cmd: ['bunx', '--bun', 'guren', 'check'], cwd })`,
    `Bun.spawnSync(['bun', 'x', 'guren', 'codegen'])`,
    // `process.execPath` is the bun binary under Bun, so this is `bunx guren`.
    // Not contrived: scripts/test-packages.ts already spawns [process.execPath, ...args].
    `Bun.spawn([process.execPath, 'x', 'guren', 'codegen'])`,
    // A type assertion on an argv element must not switch the rule off — the
    // hazard ast-walk's unwrapTypeAssertion exists for. Each of these three
    // fails if the unwrap is removed; the `satisfies` case is written on the
    // element rather than the array, because a wrapped *array* is still
    // reached by the walk and so would pass either way.
    `Bun.spawn(['bunx' as const, 'guren', 'codegen'])`,
    `Bun.spawn(['bunx' satisfies string, 'guren', 'codegen'])`,
    `Bun.spawn([process.execPath as string, 'x', 'guren'])`,
    // shell templates
    'await $`bunx guren codegen --force`.cwd(dir)',
    'await Bun.$`cd ${dir} && npx guren doctor`',
    // exec/spawn families, both the argv split and the shell command line
    `execSync('bunx guren codegen', { cwd })`,
    `spawnSync('bunx', ['guren', 'codegen'], { cwd })`,
    `execFile('npx', ['guren'], cb)`,
    `spawn('bunx guren codegen', { shell: true })`,
    `spawnSync('bunx guren codegen --force', opts)`,
  ])('flags %p', (source) => {
    expect(problems(source)).toHaveLength(1)
  })

  test.each([
    // the sanctioned replacement
    `await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir)`,
    `Bun.spawn([process.execPath, 'run', 'build'])`,
    `spawn('bunx', ['add', 'auth'])`,
    // an unrelated dynamic first element is not a runner
    `Bun.spawn([someVar, 'guren'])`,
    // mentions: docs assertions, checker fixtures, lists of documented commands
    `assert(readme.includes('bunx guren add auth'), 'README must document it.')`,
    `const md = 'Run \\\`bunx guren agent:init --target codex\\\` now.'`,
    `const documented = ['bunx guren add auth', 'bunx guren add storage']`,
    'const text = `bunx guren codegen` // not tagged, not a shell',
  ])('passes %p', (source) => {
    expect(problems(source)).toEqual([])
  })

  test('reports the shape and position it found', () => {
    expect(problems(`await run(['bunx', 'guren', 'codegen', '--force'], appDir)\n`)).toEqual([
      '1:11 argv array resolves `guren` from the registry: bunx guren codegen --force',
    ])
    expect(problems('await $`bunx guren codegen --force`.cwd(dir)')).toEqual([
      '1:7 shell template resolves `guren` from the registry: bunx guren codegen --force',
    ])
  })

  test('throws on a source it cannot parse rather than passing it silently', () => {
    expect(() => problems('const a = ;')).toThrow()
  })
})

describe('the shell scan', () => {
  test('flags a registry invocation and names its line', () => {
    const source = ['#!/usr/bin/env bash', 'set -e', 'bunx guren codegen --force'].join('\n')
    expect(collectShellViolations('x.sh', source)).toEqual([
      {
        file: 'x.sh',
        where: 'line 3',
        problem: 'resolves `guren` from the registry: bunx guren codegen --force',
      },
    ])
  })

  test('passes the sanctioned spelling and leaves commented mentions alone', () => {
    const source = [
      'CLI_BIN="$REPO_ROOT/packages/cli/src/bin.ts"',
      '(cd "$APP_DIR" && bun "$CLI_BIN" codegen --force)',
      '  # never write `bunx guren codegen` here',
    ].join('\n')
    expect(collectShellViolations('x.sh', source)).toEqual([])
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
  test('the scripts/ glob reaches the smokes, including the file this gate exists for', () => {
    const files = collectSourceFiles()
    expect(files).toContain('scripts/smoke/upgrade-existing-app.ts')
    expect(files).toContain('scripts/smoke/fresh-app.ts')
    expect(files).toContain('scripts/smoke/workspace-scripts-audit.test.ts')
  })

  test('every scripts/ source spawns the CLI locally', async () => {
    const violations = []
    for (const file of collectSourceFiles()) {
      violations.push(...collectSourceViolations(file, await Bun.file(join(repoRoot, file)).text()))
    }
    expect(violations).toEqual([])
  })
})
