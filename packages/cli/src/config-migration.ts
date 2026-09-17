/**
 * `guren doctor --next` migration hints (RFC 0027 Migration Path): an app that
 * configures a service in a provider, a `SessionConfig`-typed `config/session.ts`,
 * or `config/app.ts`'s `bootModels` gets the definition file to write, with the
 * values the old code declared. Read only: nothing here writes, and a shape it
 * cannot rewrite still yields the hint, with `content` null.
 */
import { dirname, relative, resolve } from 'node:path'
import type { File, ImportDeclaration, Node } from '@babel/types'
import { ENV_SCHEMA_FILE } from './app-env'
import { memberKeyName, objectLiteral, topLevelDeclaration, unwrapTypeAssertion, walk, type BabelNode } from './ast-walk'
import { callsDefineConfig, discoverProviderFiles, readIfExists, toPosixRelative } from './discovery'
import { parseSourceFile } from './parse-cache'
import { sessionConfigsIn } from './session-config'
import { escapeSingleQuoted } from './utils'

export interface EnvDeclaration {
  readonly key: string
  /** The builder chain, e.g. `Env.string().default('memory')`, as `insertCallOptions` takes it. */
  readonly source: string
}

export interface ConfigMigration {
  readonly key: 'cache' | 'mail' | 'queue' | 'storage' | 'session' | 'database'
  /** The files the definition replaces, relative to the app root. */
  readonly legacyFiles: readonly string[]
  readonly target: string
  /** The definition source, or null when the old shape could not be rewritten. */
  readonly content: string | null
  readonly env: readonly EnvDeclaration[]
  /** Extra work the definition does not cover, one sentence each. */
  readonly notes: readonly string[]
}

const PROVIDER_SERVICES = [
  { key: 'cache', factory: 'createCacheManager', helper: 'defineCacheConfig' },
  { key: 'mail', factory: 'createMailManager', helper: 'defineMailConfig' },
  { key: 'queue', factory: 'createQueueManager', helper: 'defineQueueConfig' },
  { key: 'storage', factory: 'createStorageManager', helper: 'defineStorageConfig' },
] as const

const BINDING_METHODS = new Set(['instance', 'singleton', 'bind'])

interface SourceFile {
  readonly path: string
  readonly source: string
}

export async function detectConfigMigrations(cwd: string): Promise<ConfigMigration[]> {
  const providers: SourceFile[] = []
  for (const path of await discoverProviderFiles(cwd)) {
    const source = await readIfExists(cwd, path)
    if (source !== null) providers.push({ path, source })
  }
  const migrations: ConfigMigration[] = []

  for (const service of PROVIDER_SERVICES) {
    if (callsDefineConfig((await readIfExists(cwd, `config/${service.key}.ts`)) ?? '', service.key)) continue
    const migration = providers.map((file) => providerMigration(cwd, file, service)).find((found) => found !== null)
    if (migration) migrations.push(migration)
  }

  const session = await sessionMigration(cwd, providers)
  if (session) migrations.push(session)

  const database = await databaseMigration(cwd, providers)
  if (database) migrations.push(database)

  return migrations
}

/** Whether `config/env.ts` exists, and the variables the migrations read that its `defineEnv()` call does not declare. */
export async function undeclaredEnv(
  cwd: string,
  migrations: readonly ConfigMigration[],
): Promise<{ exists: boolean; missing: EnvDeclaration[] }> {
  const schema = await readIfExists(cwd, ENV_SCHEMA_FILE)
  const declared = schema === null ? new Set<string>() : declaredEnvKeys(schema)
  const missing = new Map<string, EnvDeclaration>()
  for (const declaration of migrations.flatMap((migration) => migration.env)) {
    if (declared.has(declaration.key)) continue
    const existing = missing.get(declaration.key)
    if (!existing || existing.source.startsWith('Env.string().optional()')) missing.set(declaration.key, declaration)
  }
  return { exists: schema !== null, missing: [...missing.values()] }
}

function declaredEnvKeys(schema: string): Set<string> {
  const keys = new Set<string>()
  const ast = parseSourceFile(schema, ENV_SCHEMA_FILE)
  if (!ast) return keys
  walk(ast.program, (node) => {
    const callee = node.callee as BabelNode | undefined
    if (node.type !== 'CallExpression' || callee?.type !== 'Identifier' || callee.name !== 'defineEnv') return
    const object = objectLiteral((node.arguments as Node[])[0])
    for (const property of object?.properties ?? []) {
      const name = property.type === 'ObjectProperty' ? memberKeyName(property) : undefined
      if (name) keys.add(name)
    }
  })
  return keys
}

function providerMigration(cwd: string, file: SourceFile, service: (typeof PROVIDER_SERVICES)[number]): ConfigMigration | null {
  const { source } = file
  if (!source.includes(`${service.factory}(`) || !/extends\s+ServiceProvider\b/.test(source)) return null
  const ast = parseSourceFile(source, file.path)
  if (!ast) return null

  const call = boundFactoryCall(ast, service.key, service.factory)
  if (!call) return null

  const legacyFile = toPosixRelative(cwd, file.path)
  const target = `config/${service.key}.ts`
  const notes: string[] = []
  if (/\bthrow\s+new\s+Error\(/.test(source)) {
    notes.push(`Carry the boot-time name check in ${legacyFile} into the definition callback.`)
  }
  if (service.key === 'queue' && source.includes('registerJob(')) {
    notes.push(`Keep the registerJob() calls from ${legacyFile} in a provider's boot(), such as the JobsProvider \`guren add queue\` writes.`)
  }

  const argument = (call.arguments as Node[])[0]
  const config = argument ? configExpression(ast, argument) : null
  if (!config) {
    return { key: service.key, legacyFiles: [legacyFile], target, content: null, env: [], notes }
  }

  const rendered = renderDefinition(ast, source, {
    helper: service.helper,
    declarations: config.declarations,
    object: config.object,
    from: resolve(cwd, file.path),
    to: resolve(cwd, target),
    dropped: [service.factory, 'ServiceProvider'],
  })
  return { key: service.key, legacyFiles: [legacyFile], target, content: rendered.text, env: rendered.env, notes }
}

async function sessionMigration(cwd: string, providers: readonly SourceFile[]): Promise<ConfigMigration | null> {
  const target = 'config/session.ts'
  const source = await readIfExists(cwd, target)
  if (!source?.includes('SessionConfig')) return null
  const ast = parseSourceFile(source, target)
  if (!ast) return null

  const site = sessionConfigsIn(ast).find((candidate) => candidate.form === 'declared')
  if (!site) return null

  const path = resolve(cwd, target)
  const rendered = renderDefinition(ast, source, {
    helper: 'defineSessionConfig',
    declarations: [],
    object: site.config as unknown as Node,
    from: path,
    to: path,
    dropped: ['SessionConfig'],
  })
  return {
    key: 'session',
    legacyFiles: [target, ...providersContaining(cwd, providers, 'createSessionManager(')],
    target,
    content: rendered.text,
    env: rendered.env,
    notes: [],
  }
}

async function databaseMigration(cwd: string, providers: readonly SourceFile[]): Promise<ConfigMigration | null> {
  const source = await readIfExists(cwd, 'config/app.ts')
  if (!source || !/export\s+(?:async\s+)?function\s+bootModels\b/.test(source)) return null
  if (callsDefineConfig((await readIfExists(cwd, 'config/database.ts')) ?? '', 'database')) return null

  const options = source.includes('seedDatabase(') ? ", { seedOnBoot: process.env.NODE_ENV !== 'production' }" : ''
  return {
    key: 'database',
    legacyFiles: ['config/app.ts', ...providersContaining(cwd, providers, 'bootModels')],
    target: 'config/database.ts',
    content: `import { defineDatabaseConfig } from '@guren/core'\n\n// Name the dialect factory's result \`database\`, keep its named exports, and add:\nexport default defineDatabaseConfig(database${options})\n`,
    env: [],
    notes: ['defineDatabaseConfig() always connects the ORM at boot; bootModels() logic beyond that (a skipped or caught connection) does not carry over.'],
  }
}

function providersContaining(cwd: string, providers: readonly SourceFile[], needle: string): string[] {
  return providers.filter((file) => file.source.includes(needle)).map((file) => toPosixRelative(cwd, file.path))
}

/**
 * The factory call behind the container binding for `key`: inside the bound
 * value, or the initializer of the local it names. A second manager bound under
 * another key is not the service's configuration.
 */
function boundFactoryCall(ast: File, key: string, factory: string): BabelNode | null {
  let found: BabelNode | null = null
  walk(ast.program, (node) => {
    if (found) return false
    const callee = node.callee as BabelNode | undefined
    const method = callee?.type === 'MemberExpression' ? (callee.property as BabelNode) : undefined
    if (node.type !== 'CallExpression' || method?.type !== 'Identifier' || !BINDING_METHODS.has(method.name as string)) return
    const [name, value] = node.arguments as BabelNode[]
    if (name?.type !== 'StringLiteral' || name.value !== key || !value) return

    const bound = value.type === 'Identifier' ? localInitializer(ast, value.name as string) : value
    found = bound ? factoryCallIn(bound, factory) : null
  })
  return found
}

function localInitializer(ast: File, name: string): BabelNode | null {
  let init: BabelNode | null = null
  walk(ast.program, (node) => {
    const id = node.id as BabelNode | undefined
    if (node.type === 'VariableDeclarator' && id?.type === 'Identifier' && id.name === name && node.init) init = node.init as BabelNode
  })
  return init
}

function factoryCallIn(root: BabelNode, factory: string): BabelNode | null {
  let found: BabelNode | null = null
  walk(root, (node) => {
    if (found) return false
    const callee = node.callee as BabelNode | undefined
    if (node.type === 'CallExpression' && callee?.type === 'Identifier' && callee.name === factory) found = node
  })
  return found
}

/** The object a factory receives, directly or through a top-level `const`, with the top-level consts it references. */
function configExpression(ast: File, argument: Node): { object: Node; declarations: Node[] } | null {
  const topLevel = new Map<string, Node>()
  for (const statement of ast.program.body) {
    const declaration = topLevelDeclaration(statement)
    if (!declaration || declaration.kind !== 'const') continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type === 'Identifier') topLevel.set(declarator.id.name, declaration)
    }
  }

  const unwrapped = unwrapTypeAssertion(argument)
  const viaConst = unwrapped.type === 'Identifier' ? topLevel.get(unwrapped.name) : undefined
  const object = objectLiteral(unwrapped) ?? (viaConst ? objectLiteral(declaredInit(viaConst, (unwrapped as { name: string }).name)) : null)
  if (!object) return null

  const needed = new Set<Node>()
  const pending: Node[] = [object]
  while (pending.length > 0) {
    for (const name of referencedNames(pending.pop())) {
      const declaration = topLevel.get(name)
      if (declaration && declaration !== viaConst && !needed.has(declaration)) {
        needed.add(declaration)
        pending.push(declaration)
      }
    }
  }
  return { object, declarations: [...needed].sort((a, b) => (a.start ?? 0) - (b.start ?? 0)) }
}

function declaredInit(declaration: Node, name: string): Node | undefined {
  if (declaration.type !== 'VariableDeclaration') return undefined
  return declaration.declarations.find((declarator) => declarator.id.type === 'Identifier' && declarator.id.name === name)?.init ?? undefined
}

/** Identifiers read as values: not a property key, not a non-computed member name. */
function referencedNames(root: unknown): Set<string> {
  const names = new Set<string>()
  walk(root, (node, parent) => {
    if (node.type !== 'Identifier') return
    if ((parent?.type === 'ObjectProperty' || parent?.type === 'ObjectMethod') && parent.key === node && !parent.computed && !parent.shorthand) return
    if ((parent?.type === 'MemberExpression' || parent?.type === 'OptionalMemberExpression') && parent.property === node && !parent.computed) return
    names.add(node.name as string)
  })
  return names
}

interface RenderInput {
  readonly helper: string
  readonly declarations: readonly Node[]
  readonly object: Node
  readonly from: string
  readonly to: string
  readonly dropped: readonly string[]
}

function renderDefinition(ast: File, source: string, input: RenderInput): { text: string; env: EnvDeclaration[] } {
  const nodes = [...input.declarations, input.object]
  const names = new Set(nodes.flatMap((node) => [...referencedNames(node)]))
  const imported = ast.program.body.flatMap((statement) => statement.type === 'ImportDeclaration' ? statement.specifiers.map((entry) => entry.local.name) : [])
  // The callback parameter must not capture a binding the carried code already names `env`.
  const parameter = names.has('env') || imported.includes('env') ? 'validatedEnv' : 'env'

  const env = new Map<string, EnvDeclaration>()
  const pieces = nodes.map((node) => dedent(rewriteEnvReads(source, node, parameter, env)))
  const object = pieces.pop() ?? '{}'
  const body = pieces.join('\n\n')

  const imports = carriedImports(ast, source, names, input)
  const header = [`import { ${[input.helper, ...imports.core].join(', ')} } from '@guren/core'`, ...imports.lines].join('\n')
  const signature = env.size > 0 ? `(${parameter})` : '()'
  const callback = pieces.length === 0
    ? `${signature} => (${object})`
    : `${signature} => {\n${indent(body)}\n\n${indent(`return ${object}`)}\n}`
  return { text: `${header}\n\nexport default ${input.helper}(${callback})\n`, env: [...env.values()] }
}

/** `process.env.X || 'y'` becomes `env.X` declared with its default; a bare read becomes optional. */
function rewriteEnvReads(source: string, node: Node, parameter: string, env: Map<string, EnvDeclaration>): string {
  const start = node.start ?? 0
  const replacements: { start: number; end: number; key: string }[] = []
  walk(node, (current, parent) => {
    const key = envKey(current)
    if (!key || key === 'NODE_ENV' || key.startsWith('GUREN_')) return
    const logical = parent?.type === 'LogicalExpression' && (parent.operator === '||' || parent.operator === '??') && parent.left === current
    const fallback = logical ? literalSource(parent.right as BabelNode) : undefined
    const span = fallback ? parent! : current
    replacements.push({ start: (span.start as number) - start, end: (span.end as number) - start, key })
    // `??` kept a blank value, which the schema would otherwise read as unset.
    const blank = logical && parent.operator === '??' ? '.allowEmpty()' : ''
    if (fallback) env.set(key, { key, source: `${fallback.builder}.default(${fallback.value})${blank}` })
    else if (!env.has(key)) env.set(key, { key, source: `Env.string().optional()${blank}` })
    return false
  })

  let text = source.slice(start, node.end ?? start)
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    text = `${text.slice(0, replacement.start)}${parameter}.${replacement.key}${text.slice(replacement.end)}`
  }
  return text
}

function envKey(node: BabelNode): string | undefined {
  if (node.type !== 'MemberExpression') return undefined
  const object = node.object as BabelNode
  if (object.type !== 'MemberExpression' || (object.object as BabelNode).type !== 'Identifier') return undefined
  if (((object.object as BabelNode).name as string) !== 'process' || (object.property as BabelNode).name !== 'env') return undefined
  const property = node.property as BabelNode
  if (!node.computed && property.type === 'Identifier') return property.name as string
  return node.computed && property.type === 'StringLiteral' ? (property.value as string) : undefined
}

function literalSource(node: BabelNode | undefined): { builder: string; value: string } | undefined {
  if (node?.type === 'StringLiteral') return { builder: 'Env.string()', value: `'${escapeSingleQuoted(node.value as string)}'` }
  if (node?.type === 'NumericLiteral') return { builder: 'Env.number()', value: String(node.value) }
  if (node?.type === 'BooleanLiteral') return { builder: 'Env.boolean()', value: String(node.value) }
  return undefined
}

/** The file's imports the definition still references, with relative specifiers re-rooted at the target. */
function carriedImports(ast: File, source: string, bodyNames: ReadonlySet<string>, input: RenderInput): { core: string[]; lines: string[] } {
  const core: string[] = []
  const lines: string[] = []

  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    const kept = statement.specifiers.filter((entry) => !input.dropped.includes(entry.local.name) && bodyNames.has(entry.local.name))
    if (kept.length === 0) continue

    const specifier = statement.source.value
    const named = kept.filter((entry) => entry.type === 'ImportSpecifier')
    const typeOnly = statement.importKind === 'type' || named.some((entry) => entry.importKind === 'type')
    if (specifier === '@guren/core' && !typeOnly && named.length === kept.length) {
      core.push(...named.map((entry) => source.slice(entry.start ?? 0, entry.end ?? 0)))
      continue
    }

    const from = specifier.startsWith('.') ? normalizeRelative(relative(dirname(input.to), resolve(dirname(input.from), specifier))) : specifier
    lines.push(...importLines(statement, kept, source, from))
  }
  return { core, lines }
}

/** A default and a namespace import share a line; named imports cannot follow a namespace one. */
function importLines(statement: ImportDeclaration, kept: ImportDeclaration['specifiers'], source: string, from: string): string[] {
  const prefix = statement.importKind === 'type' ? 'import type ' : 'import '
  const defaultName = kept.find((entry) => entry.type === 'ImportDefaultSpecifier')?.local.name
  const namespace = kept.find((entry) => entry.type === 'ImportNamespaceSpecifier')?.local.name
  const named = kept.filter((entry) => entry.type === 'ImportSpecifier').map((entry) => source.slice(entry.start ?? 0, entry.end ?? 0))
  if (namespace) {
    const lead = [defaultName, `* as ${namespace}`].filter(Boolean).join(', ')
    return [`${prefix}${lead} from '${from}'`, ...(named.length > 0 ? [`${prefix}{ ${named.join(', ')} } from '${from}'`] : [])]
  }
  const clause = [defaultName, named.length > 0 ? `{ ${named.join(', ')} }` : undefined].filter(Boolean).join(', ')
  return [`${prefix}${clause} from '${from}'`]
}

function normalizeRelative(path: string): string {
  const posix = path.replace(/\\/g, '/')
  return posix.startsWith('.') ? posix : `./${posix}`
}

/** A slice keeps its source indentation after the first line; strip the indentation common to those lines. */
function dedent(text: string): string {
  const [first, ...rest] = text.split('\n')
  const depths = rest.filter((line) => line.trim().length > 0).map((line) => line.length - line.trimStart().length)
  const common = depths.length > 0 ? Math.min(...depths) : 0
  return [first, ...rest.map((line) => line.slice(Math.min(common, line.length - line.trimStart().length)))].join('\n')
}

function indent(text: string): string {
  return text.split('\n').map((line) => (line.length > 0 ? `  ${line}` : line)).join('\n')
}
