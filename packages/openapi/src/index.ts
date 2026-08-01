import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import type { Application, RouteDefinition } from '@guren/core'
import {
  arrayElement,
  enumValues,
  getTypeName,
  innerSchema,
  isZod3Schema,
  literalValues,
  objectShape,
  pipeSide,
  pipeSides,
  schemaAt,
  type SchemaIo,
  SINGLE_CHILD_WRAPPERS,
  typeOf,
  ZOD3_UNSUPPORTED_MESSAGE,
  type ZodSchemaLike,
} from '@guren/core/internal/zod-compat'

type WriterOptions = {
  force?: boolean
}

type ZodLike = ZodSchemaLike & {
  safeParse?: (data: unknown) => { success: boolean }
}

type OpenApiPrimitiveType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'

export interface OpenApiServer {
  url: string
  description?: string
}

export interface OpenApiDocumentOptions {
  title: string
  version: string
  description?: string
  servers?: Array<string | OpenApiServer>
}

export interface WriteOpenApiDocumentOptions extends OpenApiDocumentOptions, WriterOptions {
  appRoot?: string
  outputFile?: string
}

export interface MountOpenApiDocsOptions extends OpenApiDocumentOptions {
  jsonPath?: string
  docsPath?: string
  definitions?: RouteDefinition[] | (() => RouteDefinition[])
}

export interface OpenApiInfoObject {
  title: string
  version: string
  description?: string
}

export interface OpenApiSchemaObject {
  type?: OpenApiPrimitiveType | OpenApiPrimitiveType[]
  format?: string
  description?: string
  enum?: Array<string | number>
  const?: string | number | boolean | null
  properties?: Record<string, OpenApiSchemaObject>
  required?: string[]
  items?: OpenApiSchemaObject
  prefixItems?: OpenApiSchemaObject[]
  minItems?: number
  maxItems?: number
  additionalProperties?: boolean | OpenApiSchemaObject
  anyOf?: OpenApiSchemaObject[]
  oneOf?: OpenApiSchemaObject[]
  allOf?: OpenApiSchemaObject[]
}

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

export function generateOpenApiDocument(
  definitions: RouteDefinition[],
  options: OpenApiDocumentOptions,
): GenerateOpenApiDocumentResult {
  const warnings: string[] = []
  // Route-derived path keys go through a Map so a literal `__proto__` route
  // cannot pollute Object.prototype; method keys are fixed HTTP verbs.
  const pathEntries = new Map<string, Record<string, OpenApiOperationObject>>()

  for (const definition of definitions) {
    const pathKey = toOpenApiPath(definition.path)
    const methodKey = definition.method.toLowerCase()
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

  hono.get(jsonPath, (context: HonoLikeContext) => {
    const { document } = generateOpenApiDocument(getDefinitions(), options)
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

type ObjectSchemaDetails = {
  properties: Record<string, OpenApiSchemaObject>
  required: Set<string>
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

  const bodySchema = toOpenApiSchema(schema, warnings, `${definition.method} ${definition.path} body`, 'input')
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
    ? toOpenApiSchema(definition.schemas.output, warnings, `${definition.method} ${definition.path} response`, 'output')
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

function readObjectSchema(schema: unknown, warnings: string[], label: string, io: SchemaIo): ObjectSchemaDetails | undefined {
  if (!schema) {
    return undefined
  }

  if (isZod3Schema(schema as ZodLike)) {
    warnings.push(`${label}: skipped — ${ZOD3_UNSUPPORTED_MESSAGE}`)
    return undefined
  }

  if (!isZodSchema(schema)) {
    warnings.push(`${label}: skipped because schema is not a supported Zod schema.`)
    return undefined
  }

  const details = readObjectSchemaDetails(schema, warnings, label, io)
  if (!details) {
    warnings.push(`${label}: expected an object schema for parameter expansion.`)
  }
  return details
}

function readObjectSchemaDetails(schema: ZodLike, warnings: string[], label: string, io: SchemaIo): ObjectSchemaDetails | undefined {
  if (typeOf(schema) !== 'object') {
    const nested = unwrap(schema, io)
    return nested ? readObjectSchemaDetails(nested, warnings, label, io) : undefined
  }

  const shape = objectShape(schema)
  if (!shape) {
    warnings.push(`${label}: object schema shape could not be read.`)
    return undefined
  }

  const properties: Record<string, OpenApiSchemaObject> = {}
  const required = new Set<string>()

  for (const [key, value] of Object.entries(shape)) {
    const propertySchema = toOpenApiSchema(value, warnings, `${label}.${key}`, io)
    if (!propertySchema) {
      continue
    }

    properties[key] = propertySchema
    if (!isOptional(value, io)) {
      required.add(key)
    }
  }

  return { properties, required }
}

function toOpenApiSchema(schema: unknown, warnings: string[], label: string, io: SchemaIo): OpenApiSchemaObject | undefined {
  if (schema && typeof schema === 'object' && isZod3Schema(schema as ZodLike)) {
    warnings.push(`${label}: skipped — ${ZOD3_UNSUPPORTED_MESSAGE}`)
    return undefined
  }

  if (!isZodSchema(schema)) {
    warnings.push(`${label}: skipped because schema is not a supported Zod schema.`)
    return undefined
  }

  const typeName = typeOf(schema)
  const def = schema._def ?? {}

  // Wrappers add nothing to the rendered type, so they are looked through
  // uniformly. `nullable` is the exception — it renders as a union with null —
  // and so keeps its own case below.
  if (typeName !== 'nullable' && SINGLE_CHILD_WRAPPERS.has(typeName)) {
    const nested = unwrap(schema, io)
    if (!nested) {
      // Reaching a wrapper whose contents cannot be read drops the property,
      // so say so — `z.lazy()` hides its schema behind a getter this walker
      // does not call, and a silently missing property reads as a schema that
      // never declared one.
      warnings.push(`${label}: the contents of a "${typeName}" schema could not be read, so it is omitted.`)
      return undefined
    }
    return toOpenApiSchema(nested, warnings, label, io)
  }

  switch (typeName) {
    case 'string':
      return { type: 'string' }
    case 'number':
      return { type: 'number' }
    case 'boolean':
      return { type: 'boolean' }
    case 'bigint':
      return { type: 'integer' }
    case 'date':
      return { type: 'string', format: 'date-time' }
    case 'undefined':
      return undefined
    case 'null':
      return { type: 'null' }
    case 'literal':
      return literalSchema(def)
    case 'array': {
      const item = arrayElement(def)
      return { type: 'array', items: toOpenApiSchema(item, warnings, `${label}[]`, io) ?? {} }
    }
    case 'object': {
      const details = readObjectSchemaDetails(schema, warnings, label, io)
      if (!details) {
        return { type: 'object' }
      }
      return {
        type: 'object',
        properties: details.properties,
        required: details.required.size > 0 ? Array.from(details.required) : undefined,
      }
    }
    case 'nullable': {
      const nested = unwrap(schema, io)
      const nestedSchema = nested ? toOpenApiSchema(nested, warnings, label, io) : undefined
      return nestedSchema ? { anyOf: [nestedSchema, { type: 'null' }] } : { type: ['null'] }
    }
    case 'transform':
      warnings.push(`${label}: transform schemas are documented as generic objects.`)
      return { type: 'object' }
    // `z.discriminatedUnion()` produces this same node.
    case 'union': {
      const options = (def.options as unknown[]) ?? []
      const oneOf = options
        .map((option, index) => toOpenApiSchema(option, warnings, `${label}.option${index}`, io))
        .filter((option): option is OpenApiSchemaObject => Boolean(option))
      return oneOf.length > 0 ? { oneOf } : undefined
    }
    case 'intersection': {
      const left = toOpenApiSchema(def.left, warnings, `${label}.left`, io)
      const right = toOpenApiSchema(def.right, warnings, `${label}.right`, io)
      const allOf = [left, right].filter((value): value is OpenApiSchemaObject => Boolean(value))
      return allOf.length > 0 ? { allOf } : undefined
    }
    case 'record': {
      const valueType = schemaAt(def, 'valueType')
      return {
        type: 'object',
        additionalProperties: toOpenApiSchema(valueType, warnings, `${label}.value`, io) ?? true,
      }
    }
    // `z.nativeEnum()` produces this same node, so the values may be numbers.
    case 'enum': {
      const values = enumValues(def)
      const hasNumber = values.some((value) => typeof value === 'number')
      const hasString = values.some((value) => typeof value === 'string')
      const type = hasNumber ? (hasString ? (['string', 'number'] as OpenApiPrimitiveType[]) : 'number' as const) : 'string' as const
      return values.length > 0 ? { type, enum: values } : { type: 'string' }
    }
    case 'tuple': {
      const items = ((def.items as unknown[]) ?? [])
        .map((item, index) => toOpenApiSchema(item, warnings, `${label}[${index}]`, io))
        .filter((item): item is OpenApiSchemaObject => Boolean(item))
      return {
        type: 'array',
        prefixItems: items,
        minItems: items.length,
        maxItems: items.length,
      }
    }
    case 'promise': {
      const nested = innerSchema(def)
      return nested ? toOpenApiSchema(nested, warnings, label, io) : undefined
    }
    default:
      warnings.push(`${label}: unsupported Zod type "${typeName}".`)
      return undefined
  }
}

function normalizeServers(servers?: Array<string | OpenApiServer>): OpenApiServer[] | undefined {
  if (!servers || servers.length === 0) {
    return undefined
  }

  return servers.map((server) => typeof server === 'string' ? { url: server } : server)
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_-]+)/gu, '{$1}')
}

function extractPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([A-Za-z0-9_-]+)/gu)).map((match) => match[1] ?? '')
}

function buildOperationId(definition: RouteDefinition): string {
  const fragments = definition.path
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.startsWith(':') ? `By${capitalize(segment.slice(1))}` : capitalize(segment))

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

function isZodSchema(schema: unknown): schema is ZodLike {
  if (!schema || typeof schema !== 'object') {
    return false
  }

  return Boolean(getTypeName(schema as ZodLike))
}

/**
 * The schema a wrapper wraps, in the direction being documented. Three walks
 * look through wrappers for different reasons — finding the object behind a
 * parameter schema, rendering a type, deciding whether a property may be
 * omitted — and each layers its own handling on top (`nullable` renders as a
 * union; `optional` and friends decide presence). What none of them may do is
 * disagree about which names *are* wrappers, which is why the membership comes
 * from `SINGLE_CHILD_WRAPPERS` rather than a local list. See `pipeSides` for
 * why a pipe resolves per direction.
 */
function unwrap(schema: ZodLike, io: SchemaIo): ZodLike | undefined {
  const def = schema._def ?? {}
  const typeName = typeOf(schema)

  if (typeName === 'pipe') {
    return pipeSide(def, io)
  }

  return SINGLE_CHILD_WRAPPERS.has(typeName) ? innerSchema(def) : undefined
}

function isOptional(schema: ZodLike, io: SchemaIo): boolean {
  switch (typeOf(schema)) {
    case 'optional':
      return true
    // Both fill a missing value in, so the field may be left out of a request
    // but is always present in a response.
    case 'default':
    case 'prefault':
      return io === 'input'
    // Swallows any failure, a missing value included, and substitutes its
    // fallback — so nothing is required of a caller, and a response always
    // carries the field.
    case 'catch':
      return io === 'input'
    // Re-requires a field an inner wrapper made optional, so the walk stops
    // here rather than reading what it wraps.
    case 'nonoptional':
      return false
    // A pipeline runs both stages, so a field may be omitted only if neither
    // stage rejects a missing value. Reading just the side being rendered
    // would document an omission the other stage refuses. Still an
    // approximation in the other direction: a transforming stage can supply a
    // value the next stage accepts, which this reports as required.
    case 'pipe': {
      const { from, to } = pipeSides(schema._def ?? {})
      if (!from) {
        return false
      }
      return to ? isOptional(from, io) && isOptional(to, io) : isOptional(from, io)
    }
    default: {
      const nested = unwrap(schema, io)
      return nested ? isOptional(nested, io) : false
    }
  }
}

function literalSchema(def: Record<string, unknown>): OpenApiSchemaObject {
  // v4 literals can hold more than one value; only the first is documented
  // here (unlike the CLI's type renderer, which unions all of them).
  const value = literalValues(def)[0]

  if (typeof value === 'string') {
    return { type: 'string', const: value }
  }
  if (typeof value === 'number') {
    return { type: 'number', const: value }
  }
  if (typeof value === 'boolean') {
    return { type: 'boolean', const: value }
  }
  if (value === null) {
    return { type: 'null', const: null }
  }

  return {}
}

function isRequestBodyRequired(schema: unknown): boolean {
  if (!isZodSchema(schema)) {
    return true
  }

  return !schema.safeParse!({}).success
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
