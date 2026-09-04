import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { Application, RouteDefinition } from '@guren/core'
import type { ZodSchemaLike } from '@guren/core/internal/zod-compat'
// The shared Hono path lexer. A second copy here is how this document came to
// name a parameter `name` that the router registers as `name*`.
import { extractPathParamNames, PATH_PARAM_PATTERN } from '@guren/core/internal/route-path'
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
   * A function is resolved on every generation — for `mountOpenApiDocs()`, on
   * every request — so an app can advertise an address it does not know at mount
   * time, such as the OS-assigned port under `PORT=0`.
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
 * walker's own type under the name this package exports. A second definition is
 * how a document and an agent tool derived from one route come to advertise
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

// The only method keys an OpenAPI 3.1 Path Item may carry; a route on any other
// verb (QUERY, or router.on()) is skipped with a warning rather than emitted
// into an invalid document. 3.2 adds `query`/`additionalOperations`.
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

  // Definitions resolve lazily per request and can grow after mount, so dedupe
  // per distinct warning — not once ever — or a route registered after the first
  // fetch would be skipped without a trace.
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
  const paramsDetails = readObjectSchema(definition.schemas?.params, warnings, `${definition.method} ${definition.path} params`, 'input')

  // Raw label and rendered name differ for a `:slug*` param, and each is
  // authoritative for one half: the schema is keyed by what Hono registers
  // (`slug*`), while the document must show the RFC 6570-safe name.
  for (const rawName of extractPathParamNames(definition.path)) {
    parameters.push({
      name: stripExplodeModifier(rawName),
      in: 'path',
      required: true,
      schema: ownProperty(paramsDetails?.properties, rawName) ?? { type: 'string' },
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

/**
 * Hono keeps a trailing `*` in a parameter name (`/files/:slug*` is the key
 * `slug*`), but an OpenAPI template is an RFC 6570 URI template where `{name*}`
 * already means "explode", so it is stripped here. Applied to the template *and*
 * the parameter list, which OpenAPI requires to name the same `{name}`s.
 */
function stripExplodeModifier(label: string): string {
  return label.endsWith('*') ? label.slice(0, -1) : label
}

function toOpenApiPath(path: string): string {
  return path.replace(
    PATH_PARAM_PATTERN,
    (_match, prefix: string, label: string) => `${prefix}{${stripExplodeModifier(label)}}`,
  )
}

/**
 * A property by key, ignoring anything inherited. A path parameter may be
 * named `__proto__`, and a plain index would then hand back `Object.prototype`
 * as if it were the declared schema.
 */
function ownProperty(
  properties: Record<string, OpenApiSchemaObject> | undefined,
  key: string,
): OpenApiSchemaObject | undefined {
  return properties && Object.hasOwn(properties, key) ? properties[key] : undefined
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

  // A malformed schema can throw out of `safeParse` — zod 4 does when an
  // object's property is not a schema it recognizes — and a body whose schema
  // cannot even run against `{}` is best documented as required.
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
