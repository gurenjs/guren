import { describe, expect, it } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace } from './helpers'
import {
  directoryExists,
  isDirectoryEmpty,
  toKebabCase,
  toPackageName,
  toTitleCase,
} from '../src/utils'

describe('utils', () => {
  it('detects when a directory exists', async () => {
    const workspace = await createTempWorkspace('guren-create-app-utils-')
    try {
      const target = join(workspace.dir, 'app')
      await mkdir(target, { recursive: true })
      await expect(directoryExists(target)).resolves.toBe(true)
      await expect(directoryExists(join(workspace.dir, 'missing'))).resolves.toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects empty directories', async () => {
    const workspace = await createTempWorkspace('guren-create-app-utils-')
    try {
      const emptyDir = join(workspace.dir, 'empty')
      await mkdir(emptyDir, { recursive: true })
      await expect(isDirectoryEmpty(emptyDir)).resolves.toBe(true)
      await expect(isDirectoryEmpty(join(workspace.dir, 'missing'))).resolves.toBe(true)

      const filledDir = join(workspace.dir, 'filled')
      await mkdir(filledDir, { recursive: true })
      await writeFile(join(filledDir, 'file.txt'), 'hi', 'utf8')
      await expect(isDirectoryEmpty(filledDir)).resolves.toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('normalizes names', () => {
    expect(toKebabCase('MyApp Name')).toBe('my-app-name')
    expect(toTitleCase('my_app')).toBe('My App')
    expect(toTitleCase('')).toBe('Guren App')
    expect(toPackageName('My App')).toBe('my-app')
    expect(toPackageName('@Acme/My App')).toBe('@acme/my-app')
  })
})
