import { describe, expect, it } from 'vitest'
import { PageQuerySchema, PostFormSchema, PostIdParamSchema, PostPayloadSchema } from '../../app/Http/Validators/PostValidator.js'

describe('PostValidator', () => {
  it('normalizes post form payloads', () => {
    const result = PostFormSchema.parse({
      title: 'Hello',
      excerpt: 'Excerpt',
      body: null,
    })

    expect(result.body).toBe('')
  })

  it('defaults the page query to 1', () => {
    const result = PageQuerySchema.parse({})
    expect(result.page).toBe(1)
  })

  // The posts.store and posts.update route contracts validate with this schema
  // before the controller runs, so its refusals are asserted here.
  it('rejects a payload with empty fields, keyed by field', () => {
    const result = PostPayloadSchema.safeParse({ title: '', excerpt: '', body: '' })

    expect(result.success).toBe(false)
    const fields = result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
    expect(fields).toEqual(expect.arrayContaining(['title', 'excerpt', 'body']))
  })

  it('coerces post id params', () => {
    const result = PostIdParamSchema.parse({ id: '5' })
    expect(result.id).toBe(5)
  })
})
