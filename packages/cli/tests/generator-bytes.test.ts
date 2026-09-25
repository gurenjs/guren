import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeFeature } from '../src/make-feature'
import { makePolicy } from '../src/make-policy'
import { makeResource } from '../src/make-resource'
import { makeValidator } from '../src/make-validator'
import { parseFieldsString } from '../src/fields'

// plan:scaffold writes through the same templates, factored out of these generators;
// these pin what the generators themselves write, byte for byte.
describe('validator, resource and policy generators', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-generator-bytes-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const read = async (path: string): Promise<string> => readFile(join(dir, path), 'utf8')

  it('should write make:validator with every field type, byte for byte', async () => {
    await makeValidator('Post', { cwd: dir, fields: parseFieldsString('title:string,body:text?,views:number,draft:boolean,publishedAt:date?,meta:json') })
    expect(await read('app/Http/Validators/PostValidator.ts')).toMatchInlineSnapshot(`
      "import { z } from 'zod'

      export const PostIdParamSchema = z.object({
        id: z.coerce.number().int().positive(),
      })

      export const ListPostsQuerySchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
      })

      export const PostPayloadSchema = z.object({
        title: z.string().trim().min(1),
        body: z.string().trim().min(1).nullable().optional(),
        views: z.coerce.number(),
        draft: z.boolean(),
        publishedAt: z.coerce.date().nullable().optional(),
        meta: z.record(z.string(), z.any()),
      })

      export type PostPayload = z.infer<typeof PostPayloadSchema>
      "
    `)
  })

  it('should write make:validator with no fields, byte for byte', async () => {
    await makeValidator('Status', { cwd: dir })
    expect(await read('app/Http/Validators/StatusValidator.ts')).toMatchInlineSnapshot(`
      "import { z } from 'zod'

      export const StatusIdParamSchema = z.object({
        id: z.coerce.number().int().positive(),
      })

      export const ListStatusesQuerySchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
      })

      export const StatusPayloadSchema = z.object({
        // Add one entry per column, e.g. title: z.string().trim().min(1),
      })

      export type StatusPayload = z.infer<typeof StatusPayloadSchema>
      "
    `)
  })

  it('should write make:resource, byte for byte', async () => {
    await makeResource('Comment', { cwd: dir })
    expect(await read('app/Http/Resources/CommentResource.ts')).toMatchInlineSnapshot(`
      "import { Resource } from '@guren/core'
      import type { CommentRecord } from '../../Models/Comment.js'

      export interface CommentResourceData extends Record<string, unknown> {
        id: CommentRecord['id']
      }

      export class CommentResource extends Resource<CommentRecord, CommentResourceData> {
        toArray(): CommentResourceData {
          return {
            id: this.resource.id,
            // Map the remaining CommentRecord columns here. Only call
            // .toISOString() on Date columns — text timestamps are already strings.
          }
        }
      }
      "
    `)
  })

  it('should write make:policy, byte for byte', async () => {
    await makePolicy('Post', { cwd: dir })
    expect(await read('app/Policies/PostPolicy.ts')).toMatchInlineSnapshot(`
      "import { Policy, type AuthUser } from '@guren/core'

      interface PostLike {
        userId?: string | number
      }

      export class PostPolicy extends Policy {
        viewAny(_user: AuthUser | null): boolean {
          return true
        }

        view(_user: AuthUser | null, _post: PostLike): boolean {
          return true
        }

        create(user: AuthUser | null): boolean {
          return user !== null
        }

        update(user: AuthUser | null, post: PostLike): boolean {
          return user !== null && user.id === post.userId
        }

        delete(user: AuthUser | null, post: PostLike): boolean {
          return user !== null && user.id === post.userId
        }
      }
      "
    `)
  })

  it('should write make:feature’s validator, resource and policy, byte for byte', async () => {
    await makeFeature('Post', { cwd: dir, fields: 'title:string,body:text?,views:number,draft:boolean,publishedAt:date?,meta:json?', withPolicy: true })
    expect(await read('app/Http/Validators/PostValidator.ts')).toMatchInlineSnapshot(`
      "import { z } from 'zod'

      export const PostIdParamSchema = z.object({
        id: z.coerce.number().int().positive(),
      })

      export const ListPostsQuerySchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
      })

      export const PostPayloadSchema = z.object({
        title: z.string().trim().min(1),
        body: z.string().trim().min(1).nullable().optional(),
        views: z.coerce.number(),
        draft: z.boolean(),
        publishedAt: z.coerce.date().nullable().optional(),
        meta: z.record(z.string(), z.any()).nullable().optional(),
      })

      export type PostPayload = z.infer<typeof PostPayloadSchema>
      "
    `)
    expect(await read('app/Http/Resources/PostResource.ts')).toMatchInlineSnapshot(`
      "import { Resource } from '@guren/core'
      import type { PostRecord } from '../../Models/Post.js'

      export interface PostResourceData extends Record<string, unknown> {
        id: PostRecord['id']
        title: string
        body: string | null
        views: number
        draft: boolean
        publishedAt: string | null
        meta: Record<string, unknown> | null
      }

      export class PostResource extends Resource<PostRecord, PostResourceData> {
        toArray(): PostResourceData {
          return {
            id: this.resource.id,
            title: this.resource.title,
            body: this.resource.body ?? null,
            views: this.resource.views,
            draft: this.resource.draft,
            publishedAt: this.resource.publishedAt == null ? null : new Date(this.resource.publishedAt).toISOString(),
            meta: (this.resource.meta as Record<string, unknown> | null) ?? null,
          }
        }
      }
      "
    `)
    expect(await read('app/Policies/PostPolicy.ts')).toMatchInlineSnapshot(`
      "import { Policy, type AuthUser } from '@guren/core'

      interface PostLike {
        userId?: string | number
      }

      export class PostPolicy extends Policy {
        viewAny(_user: AuthUser | null): boolean {
          return true
        }

        view(_user: AuthUser | null, _post: PostLike): boolean {
          return true
        }

        create(user: AuthUser | null): boolean {
          return user !== null
        }

        update(user: AuthUser | null, post: PostLike): boolean {
          return user !== null && user.id === post.userId
        }

        delete(user: AuthUser | null, post: PostLike): boolean {
          return user !== null && user.id === post.userId
        }
      }
      "
    `)
  })
})
