import { resourceName, safePathSegments, writeScaffoldFile, ensureSuffix, safeModuleName } from './utils'
import type { WriterOptions } from './utils'
import { fileExists, readIfExists } from './discovery'

const TEST_ROOT = 'tests'

export type TestRunner = 'bun' | 'vitest'

// Scaffolded apps run their test script via `bun test` and don't ship
// vitest by default, so `bun:test` is the safe default. `detectRunner`
// switches to vitest when the target project has opted into it.
const FALLBACK_RUNNER: TestRunner = 'bun'

const VITEST_CONFIG_CANDIDATES = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mts',
  'vitest.config.mjs',
  'vitest.config.cts',
  'vitest.config.cjs',
]

interface PackageJsonShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * Detect which test runner the target project (cwd) is set up for.
 * Looks for a vitest config file, then for a `vitest` dependency in
 * package.json. Falls back to `bun` when neither is found.
 */
export async function detectRunner(cwd: string = process.cwd()): Promise<TestRunner> {
  for (const candidate of VITEST_CONFIG_CANDIDATES) {
    if (await fileExists(cwd, candidate)) {
      return 'vitest'
    }
  }

  const pkgRaw = await readIfExists(cwd, 'package.json')
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as PackageJsonShape
      if (pkg.dependencies?.vitest || pkg.devDependencies?.vitest) {
        return 'vitest'
      }
    } catch {
      // Malformed package.json — fall through to the default runner.
    }
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
  const runner = options.runner ?? (await detectRunner())

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
