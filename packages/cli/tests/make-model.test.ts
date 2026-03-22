import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeModel } from '../src/make-model'

describe('makeModel', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-model-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates a model file with correct name', async () => {
    const result = await makeModel('User')

    expect(result).toContain('User.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('export class User extends defineModel')
  })

  it('converts kebab-case names to PascalCase', async () => {
    const result = await makeModel('blog-post')

    expect(result).toContain('BlogPost.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class BlogPost extends defineModel')
  })

  it('converts snake_case names to PascalCase', async () => {
    const result = await makeModel('user_profile')

    expect(result).toContain('UserProfile.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class UserProfile')
  })

  it('creates file in correct directory structure', async () => {
    const result = await makeModel('Comment')

    expect(result).toContain('app/Models/Comment.ts')
  })

  it('generates pluralized schema identifier', async () => {
    const result = await makeModel('Post')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('import { posts }')
    expect(content).toContain('extends defineModel(posts)')
  })

  it('handles already pluralized names', async () => {
    const result = await makeModel('News')

    const content = await readFile(result, 'utf8')
    // 'news' already ends with 's', so it should stay 'news'
    expect(content).toContain('import { news }')
  })

  it('generates correct type definitions', async () => {
    const result = await makeModel('Article')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('export type ArticleRecord = typeof articles.$inferSelect')
    expect(content).toContain('export type NewArticleRecord = typeof articles.$inferInsert')
    expect(content).toContain('extends defineModel(articles)')
  })

  it('includes correct imports in template', async () => {
    const result = await makeModel('Test')

    const content = await readFile(result, 'utf8')
    expect(content).toContain("import { defineModel } from '@guren/orm'")
    expect(content).toContain("from '../../db/schema.js'")
  })

  it('throws error if file already exists without force flag', async () => {
    await makeModel('Existing')

    await expect(makeModel('Existing')).rejects.toThrow('already exists')
  })

  it('overwrites existing file with force flag', async () => {
    await makeModel('Overwrite')
    const result = await makeModel('Overwrite', { force: true })

    expect(result).toContain('Overwrite.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class Overwrite')
  })

  it('creates parent directories if they do not exist', async () => {
    const result = await makeModel('Nested')

    const fileExists = await access(result).then(() => true).catch(() => false)
    expect(fileExists).toBe(true)
  })

  it('generates camelCase schema identifier', async () => {
    const result = await makeModel('UserProfile')

    const content = await readFile(result, 'utf8')
    // UserProfile -> userProfiles (camelCase + pluralized)
    expect(content).toContain('import { userProfiles }')
  })
})
