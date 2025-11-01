import type { WriterOptions } from './utils'
import { resourceName, writeFileSafe } from './utils'

const TEST_ROOT = 'tests'

export type TestRunner = 'bun' | 'vitest'

const DEFAULT_RUNNER: TestRunner = 'vitest'

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
}

export async function makeTest(name: string, options: MakeTestOptions = {}): Promise<string> {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Test name is required.')
  }

  const runner = options.runner ?? DEFAULT_RUNNER

  const normalizedPath = trimmed.replace(/^\/+/gu, '').replace(/\/+$/gu, '')
  if (!normalizedPath) {
    throw new Error('Test name cannot be empty.')
  }

  const segments = normalizedPath.split('/').filter(Boolean)
  const baseSegment = segments.pop() ?? 'Example'
  const baseName = baseSegment.replace(/\.(test\.)?(t|j)sx?$/giu, '')
  const { className } = resourceName(baseName)
  const fileName = `${className}.test.ts`
  const filePath = `${TEST_ROOT}/${[...segments, fileName].join('/')}`

  const { runner: _runner, ...writer } = options
  return writeFileSafe(filePath, testTemplate(className, runner), writer)
}
