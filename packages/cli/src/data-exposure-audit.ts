/**
 * The column exposure rule of `guren audit` (RFC 0039 §7): what each response sink
 * carries, read by `column-consumers.ts`, against the model's columns, `hidden`,
 * `visible` and `appends`. A sensitive column reaching a sink is an advisory warn;
 * a value the reader cannot follow is listed as unread, never as safe.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { AppManifest } from '@guren/server'

import type { AuditFinding, AuditedRoute } from './audit'
import { inlineAuditIgnore } from './audit-config'
import { scanColumnConsumers, type ColumnConsumerModel, type ResponseSink, type SinkCarry } from './column-consumers'
import { discoverControllerFiles, discoverModelFiles, discoverResourceFiles, inAppRoot, moduleNameFor, toPosixRelative } from './discovery'
import { readManifestSection } from './manifest-section'
import { extractTableIdentifier, findStaticClassProperty, firstClassDeclaration, readModelStringArrayConfig } from './model-parser'
import { parseSourceFile, type ParseCache } from './parse-cache'
import { parseSchemaTables } from './schema-parser'

export interface DataExposureUnread {
  file: string
  line: number
  where: string
  /** The value as written, when the reader could not follow it. */
  expression?: string
  reason: string
}

export interface DataExposureReport {
  sinks: number
  unread: DataExposureUnread[]
}

interface ModelFacts {
  model: ColumnConsumerModel
  module: string | null
  /** JS property names; `null` when the model's table was not found. */
  columns: string[] | null
  opaqueColumns: boolean
  hidden: string[] | 'unreadable'
  visible: string[] | 'unreadable'
  appends: string[] | 'unreadable'
  /** The columns `ModelUserProvider.sanitize()` strips beside `hidden`. */
  credentials: string[]
}

type How = 'record' | 'column' | 'serialized' | 'auth-user'

interface Exposed {
  model: ModelFacts
  column: string
  how: How
}

const SENSITIVE_SEGMENTS = new Set(['password', 'token', 'secret', 'hash', 'otp', 'apikey'])
const SHOWN_ROUTES = 3

/** `password`, `token`, `secret`, `hash`, `apiKey` or `otp` as a whole camelCase or snake_case segment. */
export function isSensitiveColumn(name: string): boolean {
  const segments = name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean)
  return segments.some((segment, index) => SENSITIVE_SEGMENTS.has(segment) || (segment === 'api' && segments[index + 1] === 'key'))
}

function staticString(classDecl: NonNullable<ReturnType<typeof firstClassDeclaration>>, name: string): string | undefined {
  const value = findStaticClassProperty(classDecl, name)?.value
  return value?.type === 'StringLiteral' ? value.value : undefined
}

async function readModels(cwd: string): Promise<ModelFacts[]> {
  const [files, tables] = await Promise.all([discoverModelFiles(cwd), parseSchemaTables(cwd).catch(() => [])])
  const models: ModelFacts[] = []
  for (const path of files) {
    const source = await readFile(path, 'utf8').catch(() => null)
    const ast = source === null ? null : parseSourceFile(source, path)
    const classDecl = ast ? firstClassDeclaration(ast.program.body) : null
    const className = classDecl?.id?.name
    if (!classDecl || !className) continue
    const module = moduleNameFor(cwd, path)
    const identifier = extractTableIdentifier(classDecl)
    const table = identifier === undefined ? undefined : inAppRoot(tables.filter((entry) => entry.identifier === identifier), (entry) => entry.module, module)
    models.push({
      model: { className, file: toPosixRelative(cwd, path) },
      module,
      columns: table ? table.columns.map((column) => column.name) : null,
      opaqueColumns: table?.opaqueColumns === true,
      hidden: readModelStringArrayConfig(classDecl, 'hidden') ?? [],
      visible: readModelStringArrayConfig(classDecl, 'visible') ?? [],
      appends: readModelStringArrayConfig(classDecl, 'appends') ?? [],
      credentials: [staticString(classDecl, 'passwordHashField') ?? 'passwordHash', staticString(classDecl, 'rememberTokenField') ?? 'rememberToken', 'password'],
    })
  }
  return models
}

/** The model `auth.user()` returns, sanitized: only when every registered provider is the model provider of one model. */
function authUserModel(manifest: AppManifest | undefined, models: readonly ModelFacts[]): ModelFacts | string {
  if (!manifest) return 'the app was not introspected, so which user provider auth.user() reads is unknown'
  const section = readManifestSection(manifest, 'auth')
  if (section.status !== 'described') return `the auth section is unverified (${section.reason})`
  const providers = Object.values(section.value?.providers ?? {})
  if (providers.length === 0) return 'no user provider is registered at introspection, so the one boot() binds is unknown'
  if (providers.some((provider) => provider.kind !== 'model')) return 'a custom user provider is registered, which need not strip credential columns'
  const names = new Set(providers.map((provider) => provider.model))
  if (names.size !== 1) return 'more than one user model is registered'
  const [name] = names
  const model = inAppRoot(models.filter((entry) => entry.model.className === name), (entry) => entry.module, null)
  return model ?? `the user model ${name} was not found among the app's models`
}

function list(value: string[] | 'unreadable'): string[] {
  return value === 'unreadable' ? [] : value
}

function sensitiveIn(model: ModelFacts, column: string): boolean {
  return isSensitiveColumn(column) || list(model.hidden).includes(column)
}

/** What one carried value exposes, or why it could not be judged. */
function judgeCarry(carry: SinkCarry, models: ReadonlyMap<string, ModelFacts>, authUser: ModelFacts | string): { exposed: Exposed[]; unread?: string } {
  if (carry.kind === 'resource') return { exposed: [] }
  if (carry.kind === 'unknown') return { exposed: [], unread: 'the reader could not follow this value' }
  if (carry.kind === 'auth-user') {
    if (typeof authUser === 'string') return { exposed: [], unread: `auth.user() is not judged: ${authUser}` }
    const stripped = new Set([...authUser.credentials, ...list(authUser.hidden)])
    if (authUser.hidden === 'unreadable') return { exposed: [], unread: `${authUser.model.className}'s hidden list could not be read` }
    if (carry.column !== undefined) {
      return { exposed: !stripped.has(carry.column) && isSensitiveColumn(carry.column) ? [{ model: authUser, column: carry.column, how: 'auth-user' }] : [] }
    }
    if (authUser.columns === null) return { exposed: [], unread: `the table of ${authUser.model.className} could not be read` }
    const columns = [...authUser.columns, ...list(authUser.appends)].filter((column) => !stripped.has(column) && isSensitiveColumn(column))
    return { exposed: columns.map((column) => ({ model: authUser, column, how: 'auth-user' })), ...(authUser.opaqueColumns ? { unread: `${authUser.model.className}'s columns could not all be read` } : {}) }
  }
  const model = models.get(carry.model.file)
  if (!model) return { exposed: [], unread: `${carry.model.className} could not be read` }
  if (carry.kind === 'column') return { exposed: sensitiveIn(model, carry.column) ? [{ model, column: carry.column, how: 'column' }] : [] }
  if (model.columns === null) return { exposed: [], unread: `the table of ${model.model.className} could not be read` }
  const partial = model.opaqueColumns ? { unread: `${model.model.className}'s columns could not all be read` } : {}
  if (carry.kind === 'record') {
    const columns = [...model.columns, ...list(model.appends)].filter((column) => sensitiveIn(model, column))
    return { exposed: columns.map((column) => ({ model, column, how: 'record' })), ...partial }
  }
  if (model.hidden === 'unreadable' || model.visible === 'unreadable' || model.appends === 'unreadable') {
    return { exposed: [], unread: `${model.model.className}'s hidden, visible or appends list could not be read` }
  }
  // serializeRecord(): a non-empty visible list wins over hidden; appends are added first.
  const output = model.visible.length > 0
    ? model.visible
    : [...model.columns, ...model.appends].filter((column) => !model.hidden.includes(column))
  const columns = output.filter((column) => sensitiveIn(model, column))
  return { exposed: columns.map((column) => ({ model, column, how: 'serialized' })), ...partial }
}

function routesFor(sink: Pick<ResponseSink, 'file' | 'where'>, routes: readonly AuditedRoute[]): AuditedRoute[] {
  const dot = sink.where.lastIndexOf('.')
  if (dot < 0) return []
  const className = sink.where.slice(0, dot)
  const action = sink.where.slice(dot + 1)
  return routes.filter(({ controller }) => controller !== undefined
    && controller.action === action
    && (controller.name === className || controller.exportName === className)
    && (controller.file === undefined || controller.file === sink.file))
}

function describeRoutes(routes: readonly AuditedRoute[]): string {
  if (routes.length === 0) return 'no registered route was matched to it'
  const shown = routes.slice(0, SHOWN_ROUTES).map((route) => `${route.method} ${route.path}`).join(', ')
  const more = routes.length > SHOWN_ROUTES ? ` and ${routes.length - SHOWN_ROUTES} more` : ''
  const authorizing = routes.filter((route) => route.chainAuthorizes).length
  const chain = authorizing === routes.length ? 'authorization on the chain' : authorizing === 0 ? 'no authorization on the chain' : 'authorization on some chains'
  return `served by ${shown}${more}, with ${chain}`
}

const HOW_TEXT: Record<How, string> = {
  record: 'inside a whole record',
  column: 'as a column it reads',
  serialized: 'through serialize()',
  'auth-user': 'through auth.user()',
}
const SINK_TEXT: Record<ResponseSink['sink'], string> = {
  inertia: 'this.inertia() props',
  json: 'this.json()',
  toArray: 'what toArray() returns',
}

function suggestion(exposed: Exposed, where: string): string {
  const { className, file } = exposed.model.model
  if (exposed.how === 'record') return `Send only the columns the client needs, or ${className}.serialize() the record with '${exposed.column}' in hidden (${file}).`
  if (exposed.how === 'column') return `Drop ${exposed.column} from what ${where} sends unless the client needs it.`
  if (exposed.how === 'serialized') return `Add '${exposed.column}' to ${className}'s hidden list, or remove it from visible (${file}).`
  return `Add '${exposed.column}' to ${className}'s hidden list (${file}); auth.user() strips hidden columns.`
}

export async function auditDataExposure(input: {
  cwd: string
  routes: readonly AuditedRoute[]
  manifest?: AppManifest
  cache: ParseCache
  findings: AuditFinding[]
}): Promise<DataExposureReport | undefined> {
  const { cwd, routes, findings } = input
  const controllers = await discoverControllerFiles(cwd)
  if (controllers.length === 0) return undefined
  const [models, resources] = await Promise.all([readModels(cwd), discoverResourceFiles(cwd)])
  const scan = await scanColumnConsumers(cwd, {
    models: models.map((entry) => entry.model),
    controllers: controllers.map((file) => toPosixRelative(cwd, file)),
    resources: resources.map((file) => toPosixRelative(cwd, file)),
    pages: [],
    sinks: true,
  }, input.cache)
  const byFile = new Map(models.map((entry) => [entry.model.file, entry]))
  const authUser = authUserModel(input.manifest, models)
  const sinks = scan.sinks ?? []

  // A resource is served by whichever action sends it.
  const resourceRoutes = new Map<string, AuditedRoute[]>()
  for (const sink of sinks) {
    for (const carry of sink.carries) {
      if (carry.kind !== 'resource') continue
      resourceRoutes.set(carry.className, [...(resourceRoutes.get(carry.className) ?? []), ...routesFor(sink, routes)])
    }
  }

  const unread: DataExposureUnread[] = scan.unreadable.map((file) => ({ file, line: 0, where: file, reason: 'the file could not be read or parsed' }))
  const seen = new Set<string>()
  for (const sink of sinks) {
    const served = sink.kind === 'resource' ? [...new Set(resourceRoutes.get(sink.where) ?? [])] : routesFor(sink, routes)
    for (const carry of sink.carries) {
      const judged = judgeCarry(carry, byFile, authUser)
      if (judged.unread) {
        unread.push({ file: sink.file, line: carry.kind === 'unknown' ? carry.line : sink.line, where: sink.where, ...(carry.kind === 'unknown' ? { expression: carry.expression } : {}), reason: judged.unread })
      }
      for (const exposed of judged.exposed) {
        const key = `exposure-sensitive-column:${exposed.model.model.className}.${exposed.column}:${sink.where}`
        if (seen.has(key)) continue
        seen.add(key)
        // The finding carries a line, which `config/audit.ts` refuses, so the inline comment is its one suppression.
        if ((await inlineAuditIgnore(input.cache, resolve(cwd, sink.file), sink.line)) !== undefined) continue
        findings.push({
          key,
          title: `${exposed.model.model.className}.${exposed.column} in a response`,
          status: 'warn',
          message: `${sink.where} sends ${exposed.model.model.className}.${exposed.column} ${HOW_TEXT[exposed.how]} in ${SINK_TEXT[sink.sink]}; ${describeRoutes(served)}.`,
          suggestion: suggestion(exposed, sink.where),
          filePath: sink.file,
          line: sink.line,
        })
      }
    }
  }
  return { sinks: sinks.length, unread }
}
