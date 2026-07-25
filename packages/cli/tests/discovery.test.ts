import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  collectFiles,
  classNameFromPath,
  excludeBarrelFiles,
  discoverTestFiles,
  discoverModelFiles,
  discoverControllerFiles,
} from '../src/discovery'
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

describe('discoverTestFiles', () => {
  it('finds *.test.ts files under tests/', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-tests-')

    try {
      await mkdir(join(workspace.dir, 'tests/controllers'), { recursive: true })
      await writeFile(join(workspace.dir, 'tests/controllers/PostController.test.ts'), '', 'utf8')

      const files = await discoverTestFiles(workspace.dir)

      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/PostController\.test\.ts$/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('finds *.test.tsx files under tests/', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-tests-tsx-')

    try {
      await mkdir(join(workspace.dir, 'tests/pages'), { recursive: true })
      await writeFile(join(workspace.dir, 'tests/pages/Login.test.tsx'), '', 'utf8')

      const files = await discoverTestFiles(workspace.dir)

      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/Login\.test\.tsx$/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores non-test files under tests/', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-tests-nontest-')

    try {
      await mkdir(join(workspace.dir, 'tests'), { recursive: true })
      await writeFile(join(workspace.dir, 'tests/helpers.ts'), '', 'utf8')

      const files = await discoverTestFiles(workspace.dir)

      expect(files).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('returns an empty array when tests/ does not exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-tests-missing-')

    try {
      const files = await discoverTestFiles(workspace.dir)
      expect(files).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })

  it('finds *.test.ts files colocated next to source, outside tests/', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-tests-colocated-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), '', 'utf8')
      await writeFile(join(workspace.dir, 'app/Models/Post.test.ts'), '', 'utf8')

      const files = await discoverTestFiles(workspace.dir)

      expect(files).toHaveLength(1)
      expect(files[0]).toMatch(/Post\.test\.ts$/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores test files under node_modules/dist/build/coverage', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-tests-excluded-dirs-')

    try {
      await mkdir(join(workspace.dir, 'node_modules/some-pkg'), { recursive: true })
      await writeFile(join(workspace.dir, 'node_modules/some-pkg/index.test.ts'), '', 'utf8')
      await mkdir(join(workspace.dir, 'dist'), { recursive: true })
      await writeFile(join(workspace.dir, 'dist/bundle.test.js'), '', 'utf8')
      await mkdir(join(workspace.dir, 'build'), { recursive: true })
      await writeFile(join(workspace.dir, 'build/out.test.js'), '', 'utf8')
      await mkdir(join(workspace.dir, 'coverage'), { recursive: true })
      await writeFile(join(workspace.dir, 'coverage/report.test.js'), '', 'utf8')

      const files = await discoverTestFiles(workspace.dir)

      expect(files).toHaveLength(0)
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('module-aware discovery (RFC 0002)', () => {
  it('includes files under modules/<name>/app/Models alongside app/Models', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-modules-models-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}', 'utf8')

      await mkdir(join(workspace.dir, 'modules/billing/app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/billing/app/Models/Invoice.ts'), 'export class Invoice {}', 'utf8')

      const files = await discoverModelFiles(workspace.dir)

      expect(files.some(f => f.endsWith('app/Models/User.ts'))).toBe(true)
      expect(files.some(f => f.endsWith('modules/billing/app/Models/Invoice.ts'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('merges controllers from multiple modules', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-modules-multi-')

    try {
      await mkdir(join(workspace.dir, 'modules/billing/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
        'export default class InvoiceController {}',
        'utf8',
      )
      await mkdir(join(workspace.dir, 'modules/inventory/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/inventory/app/Http/Controllers/ItemController.ts'),
        'export default class ItemController {}',
        'utf8',
      )

      const files = await discoverControllerFiles(workspace.dir)

      expect(files).toHaveLength(2)
      expect(files.some(f => f.endsWith('InvoiceController.ts'))).toBe(true)
      expect(files.some(f => f.endsWith('ItemController.ts'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('excludes co-located test files from controller discovery', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-colocated-tests-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers/Auth'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.ts'),
        'export default class OAuthController {}',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/OAuthController.test.ts'),
        `test('callback', () => {})`,
        'utf8',
      )
      await mkdir(join(workspace.dir, 'modules/blog/app/Http/Controllers'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/BlogController.ts'),
        'export default class BlogController {}',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'modules/blog/app/Http/Controllers/BlogController.test.ts'),
        `test('index', () => {})`,
        'utf8',
      )

      const files = await discoverControllerFiles(workspace.dir)

      expect(files).toHaveLength(2)
      expect(files.some(f => f.endsWith('.test.ts'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('excludes co-located test files from model discovery', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-model-tests-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Models/User.test.ts'), `test('user', () => {})`, 'utf8')

      const files = await discoverModelFiles(workspace.dir)

      expect(files).toHaveLength(1)
      expect(files[0]!.endsWith('User.ts')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not error when modules/ is absent', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-modules-absent-')

    try {
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}', 'utf8')

      const files = await discoverModelFiles(workspace.dir)

      expect(files).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })

  it('ignores a non-directory entry under modules/', async () => {
    const workspace = await createTempWorkspace('guren-cli-discovery-modules-file-entry-')

    try {
      await mkdir(join(workspace.dir, 'modules'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/.gitkeep'), '', 'utf8')
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}', 'utf8')

      const files = await discoverModelFiles(workspace.dir)

      expect(files).toHaveLength(1)
    } finally {
      await workspace.cleanup()
    }
  })
})
