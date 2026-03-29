import { describe, expect, it } from 'vitest'
import { PageQuerySchema, PostFormSchema, PostIdParamSchema } from '../../app/Http/Validators/PostValidator.js'

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

  it('coerces post id params', () => {
    const result = PostIdParamSchema.parse({ id: '5' })
    expect(result.id).toBe(5)
  })
})
