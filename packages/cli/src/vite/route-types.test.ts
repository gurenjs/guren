import { describe, test, expect } from 'bun:test'
import { resolveCodegenCommand } from './route-types'

const CODEGEN_TAIL = ['codegen', '--force']

describe('resolveCodegenCommand', () => {
  test('should invoke the package bin entry with default paths', () => {
    const { executable, args } = resolveCodegenCommand({})

    expect(executable).toBe('bun')
    // Resolves via `@guren/cli`'s own package export — `dist/bin.js` in a built
    // package, or `src/bin.ts` when tsconfig path mapping favors source (as in
    // this monorepo's own test run).
    expect(args[0]).toMatch(/bin\.(ts|js)$/)
    expect(args.slice(1)).toEqual([
      ...CODEGEN_TAIL,
      '--routes', 'routes/web.ts',
      '--pages', 'resources/js/pages',
    ])
  })

  test('should forward configured paths as codegen flags', () => {
    const { args } = resolveCodegenCommand({
      watchFile: 'routes/api.ts',
      pagesDir: 'frontend/pages',
    })

    expect(args.slice(1)).toEqual([
      ...CODEGEN_TAIL,
      '--routes', 'routes/api.ts',
      '--pages', 'frontend/pages',
    ])
  })

  test('should let explicit args replace the generated command entirely', () => {
    expect(resolveCodegenCommand({ args: ['run', 'codegen'], pagesDir: 'frontend/pages' })).toEqual({
      executable: 'bun',
      args: ['run', 'codegen'],
    })
  })

  test('should respect an executable override', () => {
    const { executable } = resolveCodegenCommand({ executable: 'node' })
    expect(executable).toBe('node')
  })
})
