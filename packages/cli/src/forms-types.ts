/**
 * `.guren/forms.gen.ts` (RFC 0036 §2.1): one `RouteFormContract` per named route whose body
 * schema is an object, read off the same registered definitions `api-client.gen.ts` renders.
 * Written only for an app that depends on `@guren/inertia-client` and whose installed copy
 * exports `./forms`; otherwise a stale file is removed, as `agents.gen.ts` is.
 */
import { readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  innerSchema,
  objectShape,
  pipeSides,
  PRESENCE_WRAPPERS,
  schemaAt,
  schemaChecks,
  schemaFormat,
  TRANSPARENT_WRAPPERS,
  typeOf,
  unwrapSingleChild,
  type ZodSchemaLike,
} from '@guren/server/internal/zod-compat'
import { isZodSchema, toJsonSchema, type JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import type { RouteDefinitionLike } from './api-client-types'
import { CliError } from './cli-error'
import { appDependsOn } from './discovery'
import { objectNode, permitsOmission } from './route-contract-check'
import { schemaToTypeString } from './schema-type-extractor'
import { escapeSingleQuoted, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'
import { WHITESPACE_AND_CASE_OVERWRITES } from './zod-overwrites'

export const FORMS_MANIFEST_FILE = '.guren/forms.gen.ts'

const CLIENT_PACKAGE = '@guren/inertia-client'
const FORMS_SUBPATH = './forms'

/** The line codegen prints once when the installed client predates the `forms` subpath. */
export const FORMS_CLIENT_UPGRADE_HINT =
  `${FORMS_MANIFEST_FILE} needs ${CLIENT_PACKAGE}/forms, which the installed ${CLIENT_PACKAGE} does not export. `
  + `Run: bun add ${CLIENT_PACKAGE}@latest`

/** Mirrors `FieldContract` in `@guren/inertia-client/forms`; the generated file is checked against it. */
export interface FieldContract {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown'
  required: boolean
  nullable?: boolean
  format?: string
  value?: 'Date' | 'string'
  enum?: (string | number)[]
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  multipleOf?: number
}

export interface FormContract {
  identifier: string
  route: string
  method: string
  path: string
  fields: Record<string, FieldContract>
}

export type FormsManifestPlan =
  | { kind: 'write'; contracts: FormContract[]; warnings: string[] }
  | { kind: 'skip'; reason: 'no-client' | 'no-routes' }
  | { kind: 'skip'; reason: 'client-without-forms'; hint: string }

// The methods an Inertia form submits with; a body-bound QUERY route takes no form.
const FORM_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const FIELD_TYPES = new Set<FieldContract['type']>(['string', 'number', 'integer', 'boolean', 'array', 'object'])

/**
 * Whether the client the app installs exports `./forms`: `null` when no `node_modules` from the
 * app root up holds one. Walked by hand: Bun's `createRequire().resolve()` falls back to its global
 * install cache, whose copy is no install of the app's.
 */
export async function installedClientExportsForms(appRoot: string): Promise<boolean | null> {
  for (let dir = resolve(appRoot); ; dir = dirname(dir)) {
    const text = await readFile(join(dir, 'node_modules', CLIENT_PACKAGE, 'package.json'), 'utf8').catch(() => undefined)
    if (text !== undefined) {
      try {
        const manifest = JSON.parse(text) as { exports?: Record<string, unknown> }
        return Boolean(manifest.exports && FORMS_SUBPATH in manifest.exports)
      } catch {
        return null
      }
    }
    if (dirname(dir) === dir) return null
  }
}

/** `posts.store` → `postsStoreForm`; any character outside an identifier starts a new word. */
export function formIdentifier(routeName: string): string {
  const words = routeName.split(/[^A-Za-z0-9]+/u).filter(Boolean)
  const camel = words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('')
  const identifier = `${camel}Form`
  return /^[0-9]/u.test(identifier) ? `_${identifier}` : identifier
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The leaf a field's input side ends at, through every wrapper and a pipe's first stage. */
function inputLeaf(schema: ZodSchemaLike): ZodSchemaLike {
  let node = schema
  for (let depth = 0; depth < 32; depth += 1) {
    const nested = unwrapSingleChild(node, 'input')
    if (!nested) return node
    node = nested
  }
  return node
}

/** `z.date()` takes a `Date`; `z.coerce.date()` and `z.iso.datetime()` take a string. */
function dateValueKind(schema: ZodSchemaLike): 'Date' | 'string' {
  const leaf = inputLeaf(schema)
  return typeOf(leaf) === 'date' && (leaf._def as { coerce?: unknown } | undefined)?.coerce !== true ? 'Date' : 'string'
}

function isNullSchema(node: JsonSchemaObject): boolean {
  return node.type === 'null' || (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === 'null')
}

/** The walker renders `.nullable()` as `anyOf: [inner, null]`, once per wrapper; fold every layer back. */
function foldNullable(rendered: JsonSchemaObject): { node: JsonSchemaObject | undefined; nullable: boolean } {
  let node: JsonSchemaObject = rendered
  let nullable = false
  for (;;) {
    if (isNullSchema(node)) return { node: undefined, nullable: true }
    const inner = node.anyOf?.length === 2 && node.anyOf.some(isNullSchema) ? node.anyOf.find((option) => !isNullSchema(option)) : undefined
    if (!inner) return { node, nullable }
    node = inner
    nullable = true
  }
}

const OMISSIBLE_LEAVES = new Set(['undefined', 'void', 'unknown', 'any'])

/**
 * Whether a request may leave the key out: `permitsOmission()`, which reads the presence
 * wrappers, plus the leaves and union members that accept `undefined` (`z.unknown()`,
 * `z.string().or(z.undefined())`), which it reports as required.
 */
function acceptsOmission(schema: ZodSchemaLike, depth = 0): boolean {
  if (permitsOmission(schema)) return true
  if (depth > 32) return false
  const type = typeOf(schema)
  if (type === 'nonoptional') return false
  if (OMISSIBLE_LEAVES.has(type)) return true
  if (type === 'union') {
    const options = (schema._def as { options?: unknown } | undefined)?.options
    return Array.isArray(options) && options.some((option) => acceptsOmission(option as ZodSchemaLike, depth + 1))
  }
  if (type === 'pipe') {
    const { from, to } = pipeSides(schema._def ?? {})
    return Boolean(from && acceptsOmission(from, depth + 1) && (!to || acceptsOmission(to, depth + 1)))
  }
  const nested = unwrapSingleChild(schema, 'input')
  return nested ? acceptsOmission(nested, depth + 1) : false
}

/** The node a field is once its presence, nullable and transparent wrappers are looked through. */
function fieldCore(schema: ZodSchemaLike): ZodSchemaLike {
  let node = schema
  for (let depth = 0; depth < 32; depth += 1) {
    const type = typeOf(node)
    if (!PRESENCE_WRAPPERS.has(type) && !TRANSPARENT_WRAPPERS.has(type) && type !== 'nullable') return node
    const inner = innerSchema(node._def ?? {})
    if (!inner) return node
    node = inner
  }
  return node
}

const LENGTH_CHECKS = new Set(['min_length', 'max_length', 'length_equals'])

/**
 * `z.string().trim().toLowerCase().pipe(z.email())`: a first stage that only trims, changes case
 * and bounds the length hands the out side what an email input holds, so the email it must be is
 * the field's format. Any other check or transform there could turn a non-email into one.
 */
function emailBehindPipe(schema: ZodSchemaLike): boolean {
  if (swallowsFailure(schema)) return false
  const pipe = fieldCore(schema)
  if (typeOf(pipe) !== 'pipe') return false
  const from = schemaAt(pipe._def ?? {}, 'in')
  const to = schemaAt(pipe._def ?? {}, 'out')
  if (!from || !to || typeOf(from) !== 'string' || schemaFormat(from) !== undefined || from._def?.coerce === true) return false
  const normalizes = schemaChecks(from).every((check) =>
    LENGTH_CHECKS.has(check.check) || (check.check === 'overwrite' && WHITESPACE_AND_CASE_OVERWRITES.has(String(check.tx))))
  if (!normalizes) return false
  const out = toJsonSchema(to, [], 'pipe out', 'input')
  return out?.type === 'string' && out.format === 'email'
}

/**
 * A `.catch()` on the way to the email accepts any string, so no format may block one.
 * Reads wrappers and both pipe sides; a `lazy` child is unreadable and counts as swallowing.
 */
function swallowsFailure(schema: ZodSchemaLike, depth = 0): boolean {
  if (depth > 32) return true
  const type = typeOf(schema)
  if (type === 'catch' || type === 'lazy') return true
  if (type === 'pipe') {
    const { from, to } = pipeSides(schema._def ?? {})
    return Boolean((from && swallowsFailure(from, depth + 1)) || (to && swallowsFailure(to, depth + 1)))
  }
  if (!PRESENCE_WRAPPERS.has(type) && !TRANSPARENT_WRAPPERS.has(type) && type !== 'nullable') return false
  const inner = innerSchema(schema._def ?? {})
  return inner ? swallowsFailure(inner, depth + 1) : false
}

/**
 * A union every member of which parses to a boolean, one of them taking a boolean as sent
 * (`z.union([z.boolean(), z.string().transform(…).pipe(z.boolean())])`): a checkbox submits `checked`.
 */
function parsesToBoolean(schema: ZodSchemaLike): boolean {
  const core = fieldCore(schema)
  if (typeOf(core) !== 'union' || schemaToTypeString(core, { io: 'output' }) !== 'boolean') return false
  return (schemaToTypeString(core, { io: 'input' }) ?? '').split(' | ').includes('boolean')
}

/** One body key as a contract field. A key the walker cannot render stays, as `unknown`. */
export function readFieldContract(schema: ZodSchemaLike, warnings: string[], label: string): FieldContract {
  const required = !acceptsOmission(schema)
  const rendered = toJsonSchema(schema, warnings, label, 'input')
  if (!rendered) return { type: 'unknown', required }

  const { node, nullable } = foldNullable(rendered)
  const read = node && typeof node.type === 'string' && FIELD_TYPES.has(node.type as FieldContract['type'])
    ? node.type as FieldContract['type']
    : 'unknown'
  const type = read === 'unknown' && node && parsesToBoolean(schema) ? 'boolean' : read
  const field: FieldContract = { type, required }
  if (nullable) field.nullable = true
  if (!node) return field

  if (node.format) field.format = node.format
  else if (type === 'string' && emailBehindPipe(schema)) field.format = 'email'
  if (node.format === 'date-time') field.value = dateValueKind(schema)
  if (node.enum && node.enum.length > 0) field.enum = [...node.enum]
  const bounds = {
    minLength: finite(node.minLength),
    maxLength: finite(node.maxLength),
    minimum: finite(node.minimum),
    maximum: finite(node.maximum),
    multipleOf: finite(node.multipleOf),
  }
  for (const [key, value] of Object.entries(bounds)) {
    if (value !== undefined) field[key as keyof typeof bounds] = value
  }
  return field
}

/**
 * The contracts the definitions yield, first definition per name. Throws on two route names
 * that camel-case to one identifier: a suffix would give one page a name that moves when a
 * route is added, and renaming a route is the author's choice.
 */
export function buildFormContracts(definitions: readonly RouteDefinitionLike[], warnings: string[]): FormContract[] {
  const seen = new Set<string>()
  const byIdentifier = new Map<string, string>()
  const contracts: FormContract[] = []

  for (const definition of [...definitions].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))) {
    const name = definition.name
    const body = definition.schemas?.body
    if (!name || seen.has(name) || !FORM_METHODS.has(definition.method.toUpperCase()) || !isZodSchema(body)) continue
    seen.add(name)
    const object = objectNode(body)
    const shape = object ? objectShape(object) : undefined
    if (!shape) continue

    const identifier = formIdentifier(name)
    const clash = byIdentifier.get(identifier)
    if (clash !== undefined) {
      throw new Error(
        `Routes "${clash}" and "${name}" both give the form contract identifier "${identifier}" in ${FORMS_MANIFEST_FILE}. Rename one of the routes.`,
      )
    }
    byIdentifier.set(identifier, name)

    // No prototype, so a key named `__proto__` is an own property like any other.
    const fields: Record<string, FieldContract> = Object.create(null)
    for (const [key, schema] of Object.entries(shape)) {
      fields[key] = readFieldContract(schema, warnings, `${definition.method} ${definition.path} body.${key}`)
    }
    contracts.push({ identifier, route: name, method: definition.method, path: definition.path, fields })
  }

  return contracts
}

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(renderValue).join(', ')}]`
  return typeof value === 'string' ? `'${escapeSingleQuoted(value)}'` : JSON.stringify(value)
}

function renderKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) && key !== '__proto__' ? key : `[${JSON.stringify(key)}]`
}

function renderField(field: FieldContract): string {
  return `{ ${Object.entries(field).map(([key, value]) => `${key}: ${renderValue(value)}`).join(', ')} }`
}

export function buildFormsContent(contracts: readonly FormContract[]): string {
  const blocks = contracts.map((contract) => {
    const route = escapeSingleQuoted(contract.route)
    const path = escapeSingleQuoted(contract.path)
    const fields = Object.entries(contract.fields).map(([key, field]) => `    ${renderKey(key)}: ${renderField(field)},`)
    return `export const ${contract.identifier}: RouteFormContract<'${route}', '${contract.method}', '${path}', ApiRoutes['${route}']['body']> = {
  route: '${route}',
  method: '${contract.method}',
  path: '${path}',
  fields: {
${fields.join('\n')}
  },
}`
  })

  return `// Generated — DO NOT EDIT
// Run \`guren codegen\` to regenerate.
import type { RouteFormContract } from '${CLIENT_PACKAGE}/forms'
import type { ApiRoutes } from './api-client.gen'

${blocks.join('\n\n')}
`
}

/** What codegen would do with `forms.gen.ts` for these definitions; `check` compares against it. */
export async function planFormsManifest(appRoot: string, definitions: readonly RouteDefinitionLike[]): Promise<FormsManifestPlan> {
  if ((await appDependsOn(appRoot, CLIENT_PACKAGE)) !== true) return { kind: 'skip', reason: 'no-client' }
  const warnings: string[] = []
  const contracts = buildFormContracts(definitions, warnings)
  if (contracts.length === 0) return { kind: 'skip', reason: 'no-routes' }
  if ((await installedClientExportsForms(appRoot)) !== true) {
    return { kind: 'skip', reason: 'client-without-forms', hint: FORMS_CLIENT_UPGRADE_HINT }
  }
  return { kind: 'write', contracts, warnings }
}

export async function generateFormTypes(
  definitions: RouteDefinitionLike[],
  options: { appRoot?: string } & WriterOptions = {},
): Promise<{ outputPath: string; warnings: string[] }> {
  const appRoot = resolveAppRoot(options)
  const outputFile = resolve(appRoot, FORMS_MANIFEST_FILE)
  const plan = await planFormsManifest(appRoot, definitions)

  if (plan.kind === 'skip') {
    await rm(outputFile, { force: true })
    return { outputPath: '', warnings: plan.reason === 'client-without-forms' ? [plan.hint] : [] }
  }

  const outputPath = await writeGeneratedFileIn(appRoot, outputFile, buildFormsContent(plan.contracts), { force: options.force })
  return { outputPath, warnings: plan.warnings }
}

/**
 * Refuses, before any write, to emit an import of `@guren/inertia-client/forms` into an app whose
 * installed client predates it. An app with no client installed yet is let through: nothing can be
 * read, and the import resolves once it installs a current one.
 */
export async function assertClientExportsForms(appRoot: string, what: string): Promise<void> {
  if ((await installedClientExportsForms(appRoot)) === false) {
    throw new CliError(`${what} ${CLIENT_PACKAGE}/forms, which the installed ${CLIENT_PACKAGE} does not export. Run: bun add ${CLIENT_PACKAGE}@latest`)
  }
}
