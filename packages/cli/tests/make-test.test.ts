import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createTempWorkspace } from './helpers'
import { makeTest } from '../src/make-test'

describe('makeTest', () => {
  it('creates a test file using the provided runner', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-')
    try {
      const result = await makeTest('auth/login', { runner: 'bun' })

      expect(result).toContain('tests/auth/Login.test.ts')
      const content = await readFile(result, 'utf8')
      expect(content).toContain("from 'bun:test'")
      expect(content).toContain("describe('Login'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('throws when the test name is empty', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-test-empty-')
    try {
      await expect(makeTest('   ')).rejects.toThrow('Test name is required')
    } finally {
      await workspace.cleanup()
    }
  })
})
