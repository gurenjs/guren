import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeController } from '../src/make-controller'

describe('makeController', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-controller-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates a controller file with correct name', async () => {
    const result = await makeController('User')

    expect(result).toContain('UserController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('export default class UserController extends Controller')
  })

  it('appends Controller suffix if not present', async () => {
    const result = await makeController('Post')

    expect(result).toContain('PostController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class PostController')
  })

  it('does not duplicate Controller suffix', async () => {
    const result = await makeController('CommentController')

    expect(result).toContain('CommentController.ts')
    expect(result).not.toContain('CommentControllerController')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class CommentController')
    expect(content).not.toContain('CommentControllerController')
  })

  it('converts kebab-case names to PascalCase', async () => {
    const result = await makeController('user-profile')

    expect(result).toContain('UserProfileController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class UserProfileController')
  })

  it('converts snake_case names to PascalCase', async () => {
    const result = await makeController('blog_post')

    expect(result).toContain('BlogPostController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class BlogPostController')
  })

  it('creates file in correct directory structure', async () => {
    const result = await makeController('Dashboard')

    expect(result).toContain('app/Http/Controllers/DashboardController.ts')
  })

  it('generates correct inertia path in template', async () => {
    const result = await makeController('AdminSettings')

    const content = await readFile(result, 'utf8')
    expect(content).toContain("inertia('admin-settings/Index'")
  })

  it('includes correct imports in template', async () => {
    const result = await makeController('Test')

    const content = await readFile(result, 'utf8')
    expect(content).toContain("import { Controller } from '@guren/server'")
  })

  it('throws error if file already exists without force flag', async () => {
    await makeController('Existing')

    await expect(makeController('Existing')).rejects.toThrow('already exists')
  })

  it('overwrites existing file with force flag', async () => {
    await makeController('Overwrite')
    const result = await makeController('Overwrite', { force: true })

    expect(result).toContain('OverwriteController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class OverwriteController')
  })

  it('creates parent directories if they do not exist', async () => {
    const result = await makeController('Nested')

    // File should be created even though app/Http/Controllers didn't exist
    // access() resolves without throwing if file exists
    const fileExists = await access(result).then(() => true).catch(() => false)
    expect(fileExists).toBe(true)
  })
})
