import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { z } from 'zod'
import * as z3 from 'zod/v3'
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

  // zod 4 keeps an array's element in `_def.element` and the literal string
  // `'array'` in `_def.type` — reading the wrong key still produces a
  // document, just one with the element type missing. The zod 3 API, whose
  // `_def.type` holds a schema instead, is refused up front.
  describe('schema walking', () => {
    // `.pipe()` statically requires the target to accept the source's output,
    // but the walker reads whatever schema object it is handed at runtime.
    const pipeTo = (from: unknown, to: unknown) => (from as { pipe(target: unknown): unknown }).pipe(to)

    const operationFor = (schemas: Record<string, unknown>) => {
      const { document, warnings } = generateOpenApiDocument(
        [{ method: 'POST', path: '/posts', schemas }] as RouteDefinition[],
        { title: 'Blog API', version: '1.0.0' },
      )
      return { operation: document.paths['/posts']?.post, warnings }
    }

    const bodyDocument = (body: unknown) => {
      const { operation, warnings } = operationFor({ body })
      return { schema: operation?.requestBody?.content['application/json']?.schema, warnings }
    }

    const responseDocument = (output: unknown) => {
      const { operation, warnings } = operationFor({ output })
      return { schema: operation?.responses['201']?.content?.['application/json']?.schema, warnings }
    }

    const queryParameters = (query: unknown) => {
      const { operation, warnings } = operationFor({ query })
      return { parameters: operation?.parameters, warnings }
    }

    it('keeps the element type of a zod 4 array', () => {
      const { schema, warnings } = bodyDocument(z.object({ tags: z.array(z.string()) }))

      expect(schema?.properties?.tags).toEqual({ type: 'array', items: { type: 'string' } })
      expect(warnings).toEqual([])
    })

    // The zod 3 API is refused with a warning, not walked: on a v3 node
    // `_def.type` holds a nested schema where v4 keeps the type name, so
    // rendering it with v4 reads produces silently wrong output. `zod/v3`
    // ships inside zod 4 itself, so this arrives from apps declaring zod 4.
    it('refuses a zod 3 schema with a warning naming the zod v3 API', () => {
      const asBody = bodyDocument(z3.object({ tags: z3.array(z3.string()) }))
      expect(asBody.schema).toBeUndefined()
      expect(asBody.warnings).toHaveLength(1)
      expect(asBody.warnings[0]).toContain('zod v3 API')

      const asQuery = queryParameters(z3.object({ page: z3.number() }))
      expect(asQuery.parameters).toBeUndefined()
      expect(asQuery.warnings.some((w) => w.includes('zod v3 API'))).toBe(true)
    })

    // A pipe carries two types: `_def.in` is what a caller sends, `_def.out`
    // what the controller returns. Requests and responses need opposite sides.
    it('reports each side of a pipe to the message that carries it', () => {
      expect(bodyDocument(z.object({ page: z.string().pipe(z.coerce.number()) })).schema?.properties?.page)
        .toEqual({ type: 'string' })
      expect(responseDocument(z.object({ page: z.string().pipe(z.coerce.number()) })).schema?.properties?.page)
        .toEqual({ type: 'number' })
    })

    // `.transform()` is a pipe whose out side is an opaque function, so there
    // is no parsed type to recover — the in side stays the best answer.
    it('falls back to the in side of a transform', () => {
      const { schema } = responseDocument(z.object({ title: z.string() }).transform((value) => value.title))

      expect(schema).toEqual({ type: 'object', properties: { title: { type: 'string' } }, required: ['title'] })
    })

    // A default is filled in when the field is missing, so a caller may omit
    // it but a response always carries it. `prefault` behaves the same way.
    it('requires a filled-in field in a response but not in a request', () => {
      for (const schema of [
        () => z.object({ body: z.string().default('') }),
        () => z.object({ body: z.string().prefault('') }),
      ]) {
        expect(bodyDocument(schema()).schema?.required).toBeUndefined()
        expect(responseDocument(schema()).schema?.required).toEqual(['body'])
      }
    })

    it('requires a non-optional field in both directions', () => {
      const schema = () => z.object({ body: z.string().optional().nonoptional() })

      expect(bodyDocument(schema()).schema?.required).toEqual(['body'])
      expect(responseDocument(schema()).schema?.required).toEqual(['body'])
    })

    // `nullable` is the one single-child wrapper the type walk must NOT look
    // through: it renders as a union with null rather than passing its inner
    // schema out unchanged. It shares a membership list with the wrappers that
    // are looked through, so the exception has to be asserted separately —
    // otherwise dropping it just silently emits the unwrapped schema.
    it('renders a nullable property as a union with null rather than unwrapping it', () => {
      for (const schema of [
        z.object({ a: z.string().nullable() }),
      ]) {
        const { schema: document, warnings } = bodyDocument(schema)

        expect(document?.properties?.a).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
        expect(warnings).toEqual([])
      }
    })

    // The type and the presence of a property are read by separate walks over
    // separate wrapper lists, so a wrapper added to one and not the other
    // quietly makes an optional property required.
    it('looks through the same wrappers when deciding presence as when reading the type', () => {
      for (const schema of [
        z.object({ a: z.string().optional().readonly() }),
        z.object({ a: z.string().optional().nullable() }),
        z.object({ a: z.string().optional().brand<'Tagged'>() }),
        z.object({ a: z.string().optional().catch('x') }),
      ]) {
        const { schema: document, warnings } = bodyDocument(schema)

        expect(document?.properties?.a).toBeDefined()
        expect(document?.required).toBeUndefined()
        expect(warnings).toEqual([])
      }
    })

    // `.catch()` substitutes its fallback for any failure, a missing value
    // included, so an empty payload parses and the caller owes nothing.
    it('never requires a caught field of a request', () => {
      const schema = () => z.object({ mode: z.string().catch('safe') })

      expect(schema().safeParse({}).success).toBe(true)
      expect(bodyDocument(schema()).schema?.required).toBeUndefined()
      expect(responseDocument(schema()).schema?.required).toEqual(['mode'])
    })

    // A pipeline runs both stages, so reading only the side being rendered
    // documents an omission the other stage rejects.
    it('requires a piped field unless both stages accept a missing value', () => {
      for (const schema of [
        z.object({ a: z.string().optional().pipe(z.string()) }),
      ]) {
        expect(schema.safeParse({}).success).toBe(false)
        expect(bodyDocument(schema).schema?.required).toEqual(['a'])
      }

      const output = z.object({ a: pipeTo(z.string(), z.string().optional()) })
      expect(output.safeParse({}).success).toBe(false)
      expect(responseDocument(output).schema?.required).toEqual(['a'])
    })

    // `z.lazy()` keeps its schema behind a getter this walker does not call.
    // The property is unavoidably absent; what it must not be is silent.
    it('warns rather than quietly dropping a schema it cannot read', () => {
      for (const schema of [
        z.object({ a: z.lazy(() => z.string()) }),
      ]) {
        const { schema: document, warnings } = bodyDocument(schema)

        expect(document?.properties?.a).toBeUndefined()
        expect(warnings).toEqual(['POST /posts body.a: the contents of a "lazy" schema could not be read, so it is omitted.'])
      }
    })

    // Finding the object behind a parameter schema is a third walk over the
    // same wrappers, and one that reports nothing when it gives up: a wrapper
    // it fails to look through drops every parameter from the document.
    it('expands parameters through a wrapped query schema', () => {
      for (const query of [
        z.object({ page: z.number() }).default({ page: 1 }),
        z.object({ page: z.number() }).optional(),
        z.object({ page: z.number() }).nullable(),
        z.object({ page: z.number() }).readonly(),
      ]) {
        const { parameters, warnings } = queryParameters(query)

        expect(parameters).toEqual([{ name: 'page', in: 'query', required: true, schema: { type: 'number' } }])
        expect(warnings).toEqual([])
      }
    })
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
