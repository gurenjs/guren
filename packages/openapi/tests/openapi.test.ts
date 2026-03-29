import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import { createApp, type RouteDefinition } from '@guren/core'
import {
  generateOpenApiDocument,
  mountOpenApiDocs,
  writeOpenApiDocument,
} from '../src/index'

describe('@guren/openapi', () => {
  it('generates an OpenAPI document from route definitions', () => {
    const definitions: RouteDefinition[] = [
      {
        method: 'POST',
        path: '/posts/:id',
        name: 'posts.store',
        summary: 'Create a post',
        description: 'Creates a new post.',
        tags: ['Posts'],
        operationId: 'postsStore',
        deprecated: true,
        schemas: {
          params: z.object({ id: z.coerce.number() }),
          query: z.object({ preview: z.boolean().optional() }),
          body: z.object({ title: z.string(), body: z.string() }),
          output: z.object({ id: z.number(), title: z.string(), body: z.string() }),
        },
      },
    ]

    const { document, warnings } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
      description: 'Docs',
      servers: ['https://example.com'],
    })

    expect(warnings).toEqual([])
    expect(document.info.title).toBe('Blog API')
    expect(document.paths['/posts/{id}']?.post?.summary).toBe('Create a post')
    expect(document.paths['/posts/{id}']?.post?.deprecated).toBe(true)
    expect(document.paths['/posts/{id}']?.post?.parameters).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'number' } },
      { name: 'preview', in: 'query', required: false, schema: { type: 'boolean' } },
    ])
    expect(document.paths['/posts/{id}']?.post?.requestBody?.content['application/json']?.schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['title', 'body'],
    })
    expect(document.paths['/posts/{id}']?.post?.responses['201']).toBeDefined()
    expect(document.paths['/posts/{id}']?.post?.responses['422']).toBeDefined()
  })

  it('returns warnings for non-zod schemas', () => {
    const definitions: RouteDefinition[] = [
      {
        method: 'GET',
        path: '/posts',
        schemas: {
          query: {
            parse: (value: unknown) => value,
            safeParse: () => ({ success: true as const, data: {} }),
          },
        },
      },
    ]

    const { warnings, document } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
    })

    expect(warnings[0]).toContain('skipped because schema is not a supported Zod schema')
    expect(document.paths['/posts']?.get?.parameters).toBeUndefined()
  })

  it('mounts OpenAPI json and Scalar docs on an application', async () => {
    const body = z.object({ title: z.string() })
    const output = z.object({ id: z.number(), title: z.string() })
    const app = createApp({
      routes(router) {
        router.post('/posts', {
          name: 'posts.store',
          body,
          output,
          summary: 'Create a post',
        }, async ({ body: payload }) => ({ id: 1, title: payload.title }))
      },
    })

    mountOpenApiDocs(app, {
      title: 'Blog API',
      version: '1.0.0',
    })

    await app.boot()

    const jsonResponse = await app.fetch(new Request('http://localhost/openapi.json'))
    expect(jsonResponse.status).toBe(200)
    const document = await jsonResponse.json() as { info: { title: string } }
    expect(document.info.title).toBe('Blog API')

    const docsResponse = await app.fetch(new Request('http://localhost/docs'))
    expect(docsResponse.status).toBe(200)
    const html = await docsResponse.text()
    expect(html).toContain('@scalar/api-reference')
    expect(html).toContain('/openapi.json')
  })

  it('marks request bodies optional when an empty payload passes validation', () => {
    const definitions: RouteDefinition[] = [
      {
        method: 'PATCH',
        path: '/posts/:id',
        schemas: {
          body: z.object({
            title: z.string().optional(),
            body: z.string().default(''),
          }),
        },
      },
    ]

    const { document } = generateOpenApiDocument(definitions, {
      title: 'Blog API',
      version: '1.0.0',
    })

    expect(document.paths['/posts/{id}']?.patch?.requestBody?.required).toBe(false)
  })

  it('writes the generated document to disk', async () => {
    const appRoot = await mkdtemp(join(tmpdir(), 'guren-openapi-'))
    const definitions: RouteDefinition[] = [{ method: 'GET', path: '/health' }]
    try {
      const result = await writeOpenApiDocument(definitions, {
        title: 'Blog API',
        version: '1.0.0',
        appRoot,
        outputFile: '.guren/openapi.test.json',
        force: true,
      })

      expect(result.outputPath.endsWith('.guren/openapi.test.json')).toBe(true)
    } finally {
      await rm(appRoot, { recursive: true, force: true })
    }
  })
})
