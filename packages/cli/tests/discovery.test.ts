import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { collectFiles, classNameFromPath, excludeBarrelFiles } from '../src/discovery'
import { createTempWorkspace } from './helpers'

describe('collectFiles', () => {
  it('discovers .ts files recursively', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}', 'utf8')

      const files = await collectFiles(join(workspace.dir, 'app/Models'))

      expect(files).toHaveLength(2)
      expect(files.some(f => f.endsWith('Post.ts'))).toBe(true)
      expect(files.some(f => f.endsWith('User.ts'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips .d.ts files', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-dts-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/model.ts'), 'export class M {}', 'utf8')
      await writeFile(join(workspace.dir, 'src/model.d.ts'), 'declare class M {}', 'utf8')

      const files = await collectFiles(join(workspace.dir, 'src'))

      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/model\.ts$/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips dotfiles', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-dot-')

    try {
      await mkdir(join(workspace.dir, 'src'), { recursive: true })
      await writeFile(join(workspace.dir, 'src/visible.ts'), '', 'utf8')
      await writeFile(join(workspace.dir, 'src/.hidden.ts'), '', 'utf8')

      const files = await collectFiles(join(workspace.dir, 'src'))

      expect(files).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns empty array for non-existent directory', async () => {
    const files = await collectFiles('/non/existent/path')
    expect(files).toHaveLength(0)
  })
})

describe('classNameFromPath', () => {
  it('extracts class name from .ts path', () => {
    expect(classNameFromPath('/app/Models/Post.ts')).toBe('Post')
  })

  it('extracts class name from .mts path', () => {
    expect(classNameFromPath('/app/Models/User.mts')).toBe('User')
  })

  it('handles nested paths', () => {
    expect(classNameFromPath('/app/Http/Controllers/Auth/LoginController.ts')).toBe('LoginController')
  })
})

describe('excludeBarrelFiles', () => {
  it('removes index files', () => {
    const files = ['/app/Events/PostCreated.ts', '/app/Events/index.ts', '/app/Events/UserLoggedIn.ts']
    const result = excludeBarrelFiles(files)
    expect(result).toHaveLength(2)
    expect(result.some(f => f.includes('index'))).toBe(false)
  })

  it('keeps non-index files intact', () => {
    const files = ['/app/Models/Post.ts', '/app/Models/User.ts']
    const result = excludeBarrelFiles(files)
    expect(result).toHaveLength(2)
  })
})
