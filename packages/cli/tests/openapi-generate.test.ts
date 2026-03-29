import { describe, expect, it } from 'bun:test'
import { loadOpenApiModule, resolveOpenApiInfo } from '../src/openapi-generate'

describe('resolveOpenApiInfo', () => {
  it('falls back to package metadata when explicit values are missing', () => {
    expect(resolveOpenApiInfo({}, {
      name: 'blog-api',
      version: '2.0.0',
      description: 'Example app',
    })).toEqual({
      title: 'blog-api',
      version: '2.0.0',
      description: 'Example app',
    })
  })

  it('prefers explicit values over package metadata', () => {
    expect(resolveOpenApiInfo({
      title: 'Blog API',
      version: '1.2.3',
      description: 'Generated docs',
    }, {
      name: 'ignored-name',
      version: '0.0.1',
      description: 'ignored-description',
    })).toEqual({
      title: 'Blog API',
      version: '1.2.3',
      description: 'Generated docs',
    })
  })
})

describe('loadOpenApiModule', () => {
  it('wraps missing plugin errors with an installation hint', async () => {
    await expect(loadOpenApiModule(async () => {
      throw new Error('not found')
    })).rejects.toThrow('@guren/openapi')
  })
})
