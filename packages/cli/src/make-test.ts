import { resourceName, safePathSegments, writeScaffoldFile, ensureSuffix, safeModuleName } from './utils'
import type { WriterOptions } from './utils'
import { appDependsOn, fileExists } from './discovery'

const TEST_ROOT = 'tests'

export type TestRunner = 'bun' | 'vitest'

// Scaffolded apps run `bun test` and do not ship vitest by default.
const FALLBACK_RUNNER: TestRunner = 'bun'

const VITEST_CONFIG_CANDIDATES = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vitest.config.mjs',
  'vitest.config.cts',
  'vitest.config.cjs',
]

/** Which test runner the target project (cwd) is set up for. */
export async function detectRunner(cwd: string = process.cwd()): Promise<TestRunner> {
  for (const candidate of VITEST_CONFIG_CANDIDATES) {
    if (await fileExists(cwd, candidate)) {
      return 'vitest'
    }
  }

  // An unreadable manifest answers `null`, falling through to the default.
  if (await appDependsOn(cwd, 'vitest')) {
    return 'vitest'
  }

  return FALLBACK_RUNNER
}

function testTemplate(suiteName: string, runner: TestRunner): string {
  const importPath = runner === 'bun' ? 'bun:test' : 'vitest'

  return `import { describe, expect, it } from '${importPath}'

describe('${suiteName}', () => {
  it('works', () => {
    expect(true).toBe(true)
  })
})
`
}

export interface MakeTestOptions extends WriterOptions {
  runner?: TestRunner
  controller?: boolean
}

export async function makeTest(name: string, options: MakeTestOptions = {}): Promise<string> {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Test name is required.')
  }

  // Validate before `detectRunner()` — it stats up to seven files, and every
  // one of them is wasted when the name turns out to be a traversal.
  const segments = safePathSegments(trimmed, 'test name')
  // Detected in the project being scaffolded into, not the process directory.
  const runner = options.runner ?? (await detectRunner(options.cwd))

  const baseSegment = segments.pop()!
  const baseName = baseSegment.replace(/\.(test\.)?(t|j)sx?$/giu, '')
  const { className: baseClassName } = resourceName(baseName)
  const className = options.controller ? ensureSuffix(baseClassName, 'Controller') : baseClassName
  const fileName = `${className}.test.ts`
  const testRoot = options.root ? `modules/${safeModuleName(options.root)}/${TEST_ROOT}` : TEST_ROOT
  const filePath = options.controller
    ? `${testRoot}/controllers/${fileName}`
    : `${testRoot}/${[...segments, fileName].join('/')}`

  const { runner: _runner, controller: _controller, ...writer } = options
  return writeScaffoldFile(filePath, testTemplate(className, runner), writer)
}
