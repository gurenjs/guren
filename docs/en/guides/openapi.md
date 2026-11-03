# OpenAPI

Guren generates an OpenAPI 3.1 document from your routes. The schemas come from each route's [contract](./route-contracts.md), and a few annotations exist only for the document. The optional `@guren/openapi` package writes the document to a file, and can also serve it from your app with an interactive docs UI.

## Generating the Document

Install the optional `@guren/openapi` package and generate a spec from your route definitions:

```bash
bun add @guren/openapi
bunx guren openapi:generate
```

This reads your routes file, extracts Zod schemas and OpenAPI metadata from route contracts, and writes an OpenAPI 3.1 JSON document to `.guren/openapi.gen.json`.

## OpenAPI Metadata

Route contracts also accept lightweight OpenAPI annotations. These are stored on the route definition and used by the optional `@guren/openapi` plugin to generate an OpenAPI 3.1 document.

```ts
router.post('/posts', {
  body: CreatePostSchema,
  output: PostResponseSchema,
  name: 'posts.store',
  summary: 'Create a post',
  description: 'Creates a new blog post.',
  tags: ['Posts'],
}, [PostsController, 'store'])

router.get('/posts/:id', {
  params: PostIdParams,
  name: 'posts.show',
  summary: 'Get a post',
  tags: ['Posts'],
  deprecated: false,
}, [PostsController, 'show'])
```

Available OpenAPI fields:

| Field | Type | Purpose |
|-------|------|---------|
| `summary` | `string` | Short description shown in docs UI |
| `description` | `string` | Detailed explanation of the endpoint |
| `tags` | `string[]` | Group endpoints in the docs UI |
| `operationId` | `string` | Override the auto-generated operation ID |
| `deprecated` | `boolean` | Mark endpoint as deprecated |

## CLI Options

```bash
# Custom title and version
bunx guren openapi:generate --title "Blog API" --version "1.0.0"

# Custom output path
bunx guren openapi:generate --out docs/openapi.json

# Include a server URL
bunx guren openapi:generate --server "https://api.example.com"

# Overwrite existing file
bunx guren openapi:generate --force
```

## Mounting Docs at Runtime

You can also serve the OpenAPI spec and an interactive docs UI directly from your application:

```ts
import { createApp } from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'

const app = createApp({ routes: registerWebRoutes })

mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
})
```

This mounts two endpoints:

| Path | Description |
|------|-------------|
| `/openapi.json` | The generated OpenAPI 3.1 JSON document |
| `/docs` | Interactive API documentation UI (Scalar) |

Customize the paths with `jsonPath` and `docsPath` options:

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
})
```

When mounted on an `Application` instance, route definitions are read from the router automatically. For a plain Hono instance, pass `definitions` explicitly.

The `servers` option accepts a function as well as a list. A mounted document is generated per request and the function is called each time, so it can advertise an address the process does not know when it mounts the docs. With `PORT=0` the operating system assigns the port, which therefore exists only once `listen()` has returned it — a fixed list would leave the document, and every client generated from it, pointing at an address nothing is listening on:

```ts
mountOpenApiDocs(app, {
  title: 'Blog API',
  version: '1.0.0',
  servers: () => [app.address?.url ?? 'http://localhost:3000'],
})

await app.listen({ port: 0 })
```

`app.address` is where `listen()` bound this app, and `undefined` until it has. Because the function runs per request, it reads the address after `listen()` has set it. A plain Hono instance has no `Application` to ask, so return the address however that app knows it.
