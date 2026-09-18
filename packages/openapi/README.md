# @guren/openapi

OpenAPI 3.1 document generation from [Guren](https://guren.dev/) route contracts. Optional: install it when you want a spec, and the CLI command appears.

```bash
bun add @guren/openapi
```

## Generating a document

Routes that attach Zod schemas through `RouteContractOptions` (`body`, `params`, `query`) carry enough type information to describe themselves, so the document is derived from the routes rather than written beside them:

```bash
bunx guren openapi:generate
bunx guren openapi:generate --title "Blog API" --version "1.0.0"
bunx guren openapi:generate --routes routes/api.ts --out docs/openapi.json
```

Without arguments it reads `routes/web.ts` and writes `.guren/openapi.gen.json`.

## API

Each takes the route definitions to describe, so a build step can generate a document for any set of routes rather than only the one the CLI reads:

- **`generateOpenApiDocument(definitions, options)`** — returns the document as an object, for a build step that needs to post-process it.
- **`writeOpenApiDocument(definitions, options)`** — generates and writes it to a path.
- **`mountOpenApiDocs(app, options)`** — serves the document, and a documentation viewer, from the running app.

## Documentation

The [Ship an API guide](https://guren.dev/docs/guides/ship-api) covers route contracts, and the [CLI guide](https://guren.dev/docs/guides/cli) documents every `openapi:generate` option.

## License

MIT
