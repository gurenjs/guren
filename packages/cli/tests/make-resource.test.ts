import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { createTempWorkspace } from './helpers'
import { makeResource } from '../src/make-resource'

describe('makeResource', () => {
  it('generates a resource typed against the model record', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-resource-')
    try {
      const result = await makeResource('Comment', { model: 'Comment' })

      expect(result).toContain('app/Http/Resources/CommentResource.ts')
      const content = await readFile(result, 'utf8')
      expect(content).toContain(
        "import type { CommentRecord } from '../../Models/Comment.js'",
      )
      expect(content).toContain(
        'export class CommentResource extends Resource<CommentRecord, CommentResourceData>',
      )
      expect(content).toContain('export interface CommentResourceData extends Record<string, unknown>')
      // A UUID/text primary key must not be forced through a `number` cast.
      expect(content).toContain("id: CommentRecord['id']")
      expect(content).toContain('id: this.resource.id,')
      expect(content).not.toContain('as number')
      expect(content).not.toContain('override toJSON')
      expect(content).not.toContain('this.resource.createdAt?.toISOString()')
    } finally {
      await workspace.cleanup()
    }
  })

  it('derives the model name from the resource name when --model is omitted', async () => {
    const workspace = await createTempWorkspace('guren-cli-make-resource-derived-')
    try {
      const result = await makeResource('PostResource')

      const content = await readFile(result, 'utf8')
      expect(content).toContain("import type { PostRecord } from '../../Models/Post.js'")
      expect(content).toContain('extends Resource<PostRecord, PostResourceData>')
    } finally {
      await workspace.cleanup()
    }
  })
})
