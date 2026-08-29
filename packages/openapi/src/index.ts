import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { Application, RouteDefinition } from '@guren/core'
import type { ZodSchemaLike } from '@guren/core/internal/zod-compat'
import {
  isZodSchema,
  type JsonSchemaObject,
  readObjectSchema,
  toJsonSchema,
} from '@guren/core/internal/zod-json-schema'

type WriterOptions = {
  force?: boolean
}

type ZodLike = ZodSchemaLike & {
  safeParse?: (data: unknown) => { success: boolean }
}

export interface OpenApiServer {
  url: string
  description?: string
}

export interface OpenApiDocumentOptions {
  title: string
  version: string
  description?: string
  /**
   * A function is resolved every time a document is generated — for
   * `mountOpenApiDocs()`, on every request to the JSON endpoint. That is how an
   * app advertises an address it does not know at mount time: the port it binds
   * under `PORT=0` is assigned by the OS, so a fixed list written beside the
   * mount would send clients to a port nothing is listening on.
   */
  servers?: Array<string | OpenApiServer> | (() => Array<string | OpenApiServer>)
}

export interface WriteOpenApiDocumentOptions extends OpenApiDocumentOptions, WriterOptions {
  appRoot?: string
  outputFile?: string
}

export interface MountOpenApiDocsOptions extends OpenApiDocumentOptions {
  jsonPath?: string
  docsPath?: string
  definitions?: RouteDefinition[] | (() => RouteDefinition[])
  /**
   * Sink for generation warnings (e.g. routes the document cannot express).
   * Called once per distinct warning across the mount's lifetime.
   * Defaults to `console.warn` with a `[guren/openapi]` prefix.
   */
  onWarning?: (warning: string) => void
}

export interface OpenApiInfoObject {
  title: string
  version: string
  description?: string
}

/**
 * OpenAPI 3.1's Schema Object *is* JSON Schema 2020-12, so this is the shared
 * walker's own type under the name this package has always exported. Keeping
 * one definition is the point of the promotion: a second copy here is how the
 * document and an agent tool derived from the same route come to advertise
 * different constraints.
 */
export type OpenApiSchemaObject = JsonSchemaObject

export interface OpenApiParameterObject {
  name: string
  in: 'path' | 'query'
  required?: boolean
  description?: string
  schema?: OpenApiSchemaObject
}

export interface OpenApiMediaTypeObject {
  schema?: OpenApiSchemaObject
}

export interface OpenApiResponseObject {
  description: string
  content?: Record<string, OpenApiMediaTypeObject>
}

export interface OpenApiOperationObject {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  deprecated?: boolean
  parameters?: OpenApiParameterObject[]
  requestBody?: {
    required?: boolean
    content: Record<string, OpenApiMediaTypeObject>
  }
  responses: Record<string, OpenApiResponseObject>
}

export interface OpenApiDocument {
  openapi: '3.1.0'
  info: OpenApiInfoObject
  servers?: OpenApiServer[]
  paths: Record<string, Record<string, OpenApiOperationObject>>
}

export interface GenerateOpenApiDocumentResult {
  document: OpenApiDocument
  warnings: string[]
}

export interface WriteOpenApiDocumentResult extends GenerateOpenApiDocumentResult {
  outputPath: string
}

export interface MountOpenApiDocsResult {
  jsonPath: string
  docsPath: string
}

const DEFAULT_OUTPUT_FILE = '.guren/openapi.gen.json'
const DEFAULT_JSON_PATH = '/openapi.json'
const DEFAULT_DOCS_PATH = '/docs'

// The only method keys an OpenAPI 3.1 Path Item may carry. Routes registered
// with any other method (QUERY, or a custom verb via router.on()) would make
// the emitted document invalid, so they are skipped with a warning instead.
// OpenAPI 3.2 adds `query`/`additionalOperations`; revisit when the generator
// targets it.
const OPENAPI_31_METHOD_KEYS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

export function generateOpenApiDocument(
  definitions: RouteDefinition[],
  options: OpenApiDocumentOptions,
): GenerateOpenApiDocumentResult {
  const warnings: string[] = []
  // Route-derived path keys go through a Map so a literal `__proto__` route
  // cannot pollute Object.prototype; method keys are allowlisted below.
  const pathEntries = new Map<string, Record<string, OpenApiOperationObject>>()

  for (const definition of definitions) {
    const pathKey = toOpenApiPath(definition.path)
    const methodKey = definition.method.toLowerCase()
    if (!OPENAPI_31_METHOD_KEYS.has(methodKey)) {
      warnings.push(
        `Skipped ${definition.method} ${definition.path}: OpenAPI 3.1 cannot express the ${definition.method} method.`,
      )
      continue
    }
    const operation = buildOperation(definition, warnings)

    const operations = pathEntries.get(pathKey)
    if (operations) {
      operations[methodKey] = operation
    } else {
      pathEntries.set(pathKey, { [methodKey]: operation })
    }
  }

  const paths: OpenApiDocument['paths'] = Object.fromEntries(pathEntries)

  return {
    document: {
      openapi: '3.1.0',
      info: {
        title: options.title,
        version: options.version,
        description: options.description,
      },
      servers: normalizeServers(options.servers),
      paths,
    },
    warnings,
  }
}

export async function writeOpenApiDocument(
  definitions: RouteDefinition[],
  options: WriteOpenApiDocumentOptions,
): Promise<WriteOpenApiDocumentResult> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : process.cwd()
  const outputFile = resolve(appRoot, options.outputFile ?? DEFAULT_OUTPUT_FILE)
  const { document, warnings } = generateOpenApiDocument(definitions, options)
  const relativeTarget = relative(process.cwd(), outputFile) || outputFile
  const outputPath = await writeFileSafe(relativeTarget, JSON.stringify(document, null, 2), { force: options.force })

  return {
    document,
    warnings,
    outputPath,
  }
}

export function mountOpenApiDocs(
  target: Application | HonoLike,
  options: MountOpenApiDocsOptions,
): MountOpenApiDocsResult {
  const hono: HonoLike = isApplicationLike(target) ? target.hono as HonoLike : target as HonoLike
  const jsonPath = options.jsonPath ?? DEFAULT_JSON_PATH
  const docsPath = options.docsPath ?? DEFAULT_DOCS_PATH
  const getDefinitions = resolveDefinitions(target, options.definitions)

  // Serving silently would hide routes the generator had to skip (e.g. QUERY
  // under OpenAPI 3.1). Definitions resolve lazily per request and can grow
  // after mount, so dedupe per distinct warning — not once ever — or a route
  // registered after the first fetch would be skipped without a trace.
  const onWarning = options.onWarning ?? ((warning: string) => console.warn(`[guren/openapi] ${warning}`))
  const emitted = new Set<string>()
  hono.get(jsonPath, (context: HonoLikeContext) => {
    const { document, warnings } = generateOpenApiDocument(getDefinitions(), options)
    for (const warning of warnings) {
      if (emitted.has(warning)) continue
      emitted.add(warning)
      onWarning(warning)
    }
    return context.json(document)
  })

  hono.get(docsPath, (context: HonoLikeContext) => {
    return context.html(renderScalarHtml({
      title: options.title,
      jsonPath,
    }))
  })

  return { jsonPath, docsPath }
}

interface HonoLikeContext {
  json(data: unknown): Response
  html(data: string): Response
}

interface HonoLike {
  get(path: string, handler: (context: HonoLikeContext) => Response | Promise<Response>): unknown
}

function isApplicationLike(target: Application | HonoLike): target is Application & { hono: HonoLike; router: { definitions(): RouteDefinition[] } } {
  return typeof target === 'object'
    && target !== null
    && 'hono' in target
    && 'router' in target
}

function resolveDefinitions(
  target: Application | HonoLike,
  definitions?: RouteDefinition[] | (() => RouteDefinition[]),
): () => RouteDefinition[] {
  if (isApplicationLike(target)) {
    return () => target.router.definitions()
  }

  if (typeof definitions === 'function') {
    return definitions
  }

  if (definitions) {
    return () => definitions
  }

  throw new Error('mountOpenApiDocs() requires `definitions` when mounting against a Hono instance.')
}

function buildOperation(definition: RouteDefinition, warnings: string[]): OpenApiOperationObject {
  const parameters = buildParameters(definition, warnings)
  const requestBody = buildRequestBody(definition, warnings)
  const responses = buildResponses(definition, warnings)

  return {
    operationId: definition.operationId ?? definition.name ?? buildOperationId(definition),
    summary: definition.summary,
    description: definition.description,
    tags: definition.tags,
    deprecated: definition.deprecated,
    parameters: parameters.length > 0 ? parameters : undefined,
    requestBody,
    responses,
  }
}

function buildParameters(definition: RouteDefinition, warnings: string[]): OpenApiParameterObject[] {
  const parameters: OpenApiParameterObject[] = []
  const pathParamNames = extractPathParamNames(definition.path)
  const paramsDetails = readObjectSchema(definition.schemas?.params, warnings, `${definition.method} ${definition.path} params`, 'input')

  for (const name of pathParamNames) {
    parameters.push({
      name,
      in: 'path',
      required: true,
      schema: paramsDetails?.properties[name] ?? { type: 'string' },
    })
  }

  const queryDetails = readObjectSchema(definition.schemas?.query, warnings, `${definition.method} ${definition.path} query`, 'input')
  if (queryDetails) {
    for (const [name, schema] of Object.entries(queryDetails.properties)) {
      parameters.push({
        name,
        in: 'query',
        required: queryDetails.required.has(name),
        schema,
      })
    }
  }

  return parameters
}

function buildRequestBody(definition: RouteDefinition, warnings: string[]): OpenApiOperationObject['requestBody'] {
  const schema = definition.schemas?.body
  if (!schema) {
    return undefined
  }

  const bodySchema = toJsonSchema(schema, warnings, `${definition.method} ${definition.path} body`, 'input')
  if (!bodySchema) {
    return undefined
  }

  return {
    required: isRequestBodyRequired(schema),
    content: {
      'application/json': { schema: bodySchema },
    },
  }
}

function buildResponses(definition: RouteDefinition, warnings: string[]): Record<string, OpenApiResponseObject> {
  const responses: Record<string, OpenApiResponseObject> = {}
  const successStatus = definition.method === 'POST' ? '201' : '200'
  const successSchema = definition.schemas?.output
    ? toJsonSchema(definition.schemas.output, warnings, `${definition.method} ${definition.path} response`, 'output')
    : undefined

  responses[successStatus] = {
    description: successStatus === '201' ? 'Created' : 'Successful response',
    content: successSchema
      ? {
        'application/json': { schema: successSchema },
      }
      : undefined,
  }

  if (definition.schemas?.body || definition.schemas?.params || definition.schemas?.query) {
    responses['422'] = {
      description: 'Validation error',
      content: {
        'application/json': { schema: VALIDATION_ERROR_SCHEMA },
      },
    }
  }

  return responses
}

function normalizeServers(servers?: OpenApiDocumentOptions['servers']): OpenApiServer[] | undefined {
  const resolved = typeof servers === 'function' ? servers() : servers
  if (!resolved || resolved.length === 0) {
    return undefined
  }

  return resolved.map((server) => typeof server === 'string' ? { url: server } : server)
}

// Mirrors Hono's path lexing — a param starts only at a segment boundary
// (`/status/foo:bar` is a literal) and an attached regex constraint is
// consumed whole — feeding the path template, the parameter list, and the
// operation id below. One deliberate divergence: a trailing `*`
// is dropped here, though the TypeScript/runtime rule keeps it (Hono does —
// `/files/:slug*` arrives as the key `slug*`). OpenAPI path templates are RFC
// 6570 URI templates, where `{name*}` already means "explode", so emitting the
// literal asterisk would claim something else entirely.
//
// The constraint is spelled out to one level of nesting rather than with a
// nested quantifier: every class here excludes both braces, so a scan stops
// at the next brace instead of running to the end of the string. The
// `\{[^}]*\}(?:[^/]*\})*` shape it replaces was quadratic (CodeQL
// js/polynomial-redos; measured 2.9s for a 16k-char path, vs 1.9ms here).
const PATH_PARAM_PATTERN = /(^|\/):([A-Za-z0-9_-]+)(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?[?*]?/gu

function toOpenApiPath(path: string): string {
  return path.replace(PATH_PARAM_PATTERN, '$1{$2}')
}

function extractPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(PATH_PARAM_PATTERN)).map((match) => match[2] ?? '')
}

function buildOperationId(definition: RouteDefinition): string {
  // Derived from the OpenAPI path template so the id and the template cannot
  // disagree about where the params are.
  const fragments = toOpenApiPath(definition.path)
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.startsWith('{') && segment.endsWith('}')
      ? `By${capitalize(segment.slice(1, -1))}`
      : capitalize(segment))

  return `${definition.method.toLowerCase()}${fragments.join('') || 'Root'}`
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

const VALIDATION_ERROR_SCHEMA: OpenApiSchemaObject = {
  type: 'object',
  properties: {
    errors: {
      type: 'object',
      additionalProperties: { type: 'string' },
    },
  },
  required: ['errors'],
}

function renderScalarHtml(options: { title: string; jsonPath: string }): string {
  const title = escapeHtml(options.title)
  const jsonPath = escapeHtml(options.jsonPath)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      html, body {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
      }
    </style>
  </head>
  <body>
    <script
      id="api-reference"
      data-url="${jsonPath}"
      data-configuration='{"theme":"default","layout":"modern"}'
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"
    ></script>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function isRequestBodyRequired(schema: unknown): boolean {
  if (!isZodSchema(schema)) {
    return true
  }

  // `safeParse` is supposed to return failures, but a malformed schema can
  // still throw — zod 4 throws outright when an object's property is not a
  // schema it recognizes (a nested v3 node, for one). A body whose schema
  // cannot even run against `{}` is best documented as required. Running the
  // schema is this package's own business, which is why `ZodLike` (the reading
  // surface plus `safeParse`) stays here rather than in the shared walker: the
  // walker only ever *reads* a schema.
  const parseable = schema as ZodLike
  try {
    return !parseable.safeParse?.({}).success
  } catch {
    return true
  }
}

async function writeFileSafe(relativePath: string, contents: string, options: WriterOptions = {}): Promise<string> {
  const fullPath = resolve(process.cwd(), relativePath)

  await mkdir(dirname(fullPath), { recursive: true })
  try {
    // `wx` makes the exists-check and the write one atomic operation
    // (mirrors the writer in @guren/cli's utils).
    await writeFile(fullPath, contents, { encoding: 'utf8', flag: options.force ? 'w' : 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${relativePath} already exists. Use --force to overwrite.`)
    }
    throw error
  }
  return fullPath
}
