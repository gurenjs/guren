/**
 * `.guren/forms.gen.ts` (RFC 0036 §2.1): one `RouteFormContract` per named route whose body
 * schema is an object, read off the same registered definitions `api-client.gen.ts` renders.
 * Written only for an app that depends on `@guren/inertia-client` and whose installed copy
 * exports `./forms`; otherwise a stale file is removed, as `agents.gen.ts` is.
 */
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { objectShape, typeOf, unwrapSingleChild, type ZodSchemaLike } from '@guren/server/internal/zod-compat'
import { isZodSchema, toJsonSchema, type JsonSchemaObject } from '@guren/server/internal/zod-json-schema'

import type { RouteDefinitionLike } from './api-client-types'
import { appDependsOn } from './discovery'
import { objectNode, permitsOmission } from './route-contract-check'
import { escapeSingleQuoted, resolveAppRoot, writeGeneratedFileIn, type WriterOptions } from './utils'

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

const FIELD_TYPES = new Set<FieldContract['type']>(['string', 'number', 'integer', 'boolean', 'array', 'object'])

/** Whether the client the app installs exports `./forms`: `null` when none resolves from the app root. */
export async function installedClientExportsForms(appRoot: string): Promise<boolean | null> {
  let manifestPath: string
  try {
    manifestPath = createRequire(join(appRoot, 'package.json')).resolve(`${CLIENT_PACKAGE}/package.json`)
  } catch {
    return null
  }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { exports?: Record<string, unknown> }
    return Boolean(manifest.exports && FORMS_SUBPATH in manifest.exports)
  } catch {
    return null
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

/** The walker renders `.nullable()` as `anyOf: [inner, null]`; fold it back into the inner type. */
function foldNullable(rendered: JsonSchemaObject): { node: JsonSchemaObject | undefined; nullable: boolean } {
  const isNull = (node: JsonSchemaObject) => node.type === 'null' || (Array.isArray(node.type) && node.type.length === 1 && node.type[0] === 'null')
  if (isNull(rendered)) return { node: undefined, nullable: true }
  if (rendered.anyOf?.length === 2) {
    const inner = rendered.anyOf.find((option) => !isNull(option))
    if (inner && rendered.anyOf.some(isNull)) return { node: inner, nullable: true }
  }
  return { node: rendered, nullable: false }
}

/** One body key as a contract field. A key the walker cannot render stays, as `unknown`. */
export function readFieldContract(schema: ZodSchemaLike, warnings: string[], label: string): FieldContract {
  const required = !permitsOmission(schema)
  const rendered = toJsonSchema(schema, warnings, label, 'input')
  if (!rendered) return { type: 'unknown', required }

  const { node, nullable } = foldNullable(rendered)
  const type = node && typeof node.type === 'string' && FIELD_TYPES.has(node.type as FieldContract['type'])
    ? node.type as FieldContract['type']
    : 'unknown'
  const field: FieldContract = { type, required }
  if (nullable) field.nullable = true
  if (!node) return field

  if (node.format) field.format = node.format
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
    if (!name || seen.has(name) || !isZodSchema(body)) continue
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

    const fields: Record<string, FieldContract> = {}
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
