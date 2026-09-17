/**
 * `guren doctor --next` migration hints (RFC 0027 Migration Path): an app that
 * configures a service in a provider, a `SessionConfig`-typed `config/session.ts`,
 * or `config/app.ts`'s `bootModels` gets the definition file to write, with the
 * values the old code declared. Read only: nothing here writes, and a shape it
 * cannot rewrite still yields the hint, with `content` null.
 */
import { dirname, relative, resolve } from 'node:path'
import type { File, Node } from '@babel/types'
import { objectLiteral, topLevelDeclaration, unwrapTypeAssertion, type BabelNode } from './ast-walk'
import { callsDefineConfig, collectFiles, readIfExists, toPosixRelative } from './discovery'
import { parseSourceFile } from './parse-cache'
import { sessionConfigsIn } from './session-config'

export interface EnvDeclaration {
  readonly key: string
  /** The builder chain, e.g. `Env.string().default('memory')`. */
  readonly builder: string
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

type Span = { start: number; end: number; text: string }

interface Rewritten {
  text: string
  env: Map<string, EnvDeclaration>
}

export async function detectConfigMigrations(cwd: string): Promise<ConfigMigration[]> {
  const providerFiles = (await collectFiles(resolve(cwd, 'app/Providers'))).filter((file) => !/\.test\.[jt]sx?$/.test(file))
  const migrations: ConfigMigration[] = []

  for (const service of PROVIDER_SERVICES) {
    if (callsDefineConfig((await readIfExists(cwd, `config/${service.key}.ts`)) ?? '', service.key)) continue
    for (const file of providerFiles) {
      const migration = await providerMigration(cwd, file, service)
      if (migration) {
        migrations.push(migration)
        break
      }
    }
  }

  const session = await sessionMigration(cwd, providerFiles)
  if (session) migrations.push(session)

  const database = await databaseMigration(cwd, providerFiles)
  if (database) migrations.push(database)

  return migrations
}

/** The keys a migration needs that `config/env.ts` does not declare yet, merged across migrations. */
export async function undeclaredEnv(cwd: string, migrations: readonly ConfigMigration[]): Promise<EnvDeclaration[]> {
  const schema = (await readIfExists(cwd, 'config/env.ts')) ?? ''
  const merged = new Map<string, EnvDeclaration>()
  for (const declaration of migrations.flatMap((migration) => migration.env)) {
    if (new RegExp(`\\b${declaration.key}\\s*:`).test(schema)) continue
    const existing = merged.get(declaration.key)
    if (!existing || existing.builder.endsWith('.optional()')) merged.set(declaration.key, declaration)
  }
  return [...merged.values()]
}

async function providerMigration(
  cwd: string,
  file: string,
  service: (typeof PROVIDER_SERVICES)[number],
): Promise<ConfigMigration | null> {
  const source = await readIfExists(cwd, file)
  if (!source?.includes(`${service.factory}(`) || !/extends\s+ServiceProvider\b/.test(source)) return null
  const ast = parseSourceFile(source, file)
  if (!ast) return null

  const call = findCall(ast, service.factory)
  if (!call) return null

  const legacyFile = toPosixRelative(cwd, file)
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

  const body = rewriteEnvReads(source, [...config.declarations, config.object])
  const imports = carriedImports(ast, source, body.text, resolve(cwd, file), resolve(cwd, target), [service.factory, 'ServiceProvider'])
  const content = renderDefinition(service.helper, imports, body, config.declarations.length)
  return { key: service.key, legacyFiles: [legacyFile], target, content, env: [...body.env.values()], notes }
}

async function sessionMigration(cwd: string, providerFiles: readonly string[]): Promise<ConfigMigration | null> {
  const source = await readIfExists(cwd, 'config/session.ts')
  if (!source?.includes('SessionConfig')) return null
  const ast = parseSourceFile(source, 'config/session.ts')
  if (!ast) return null

  const site = sessionConfigsIn(ast).find((candidate) => candidate.form === 'declared')
  if (!site) return null

  const providers: string[] = []
  for (const file of providerFiles) {
    if ((await readIfExists(cwd, file))?.includes('createSessionManager(')) providers.push(toPosixRelative(cwd, file))
  }

  const target = resolve(cwd, 'config/session.ts')
  const body = rewriteEnvReads(source, [site.config as unknown as Node])
  const imports = carriedImports(ast, source, body.text, target, target, ['SessionConfig'])
  return {
    key: 'session',
    legacyFiles: ['config/session.ts', ...providers],
    target: 'config/session.ts',
    content: renderDefinition('defineSessionConfig', imports, body, 0),
    env: [...body.env.values()],
    notes: [],
  }
}

async function databaseMigration(cwd: string, providerFiles: readonly string[]): Promise<ConfigMigration | null> {
  const source = await readIfExists(cwd, 'config/app.ts')
  if (!source || !/export\s+(?:async\s+)?function\s+bootModels\b/.test(source)) return null

  const providers: string[] = []
  for (const file of providerFiles) {
    if ((await readIfExists(cwd, file))?.includes('bootModels')) providers.push(toPosixRelative(cwd, file))
  }

  const options = source.includes('seedDatabase(') ? ", { seedOnBoot: process.env.NODE_ENV !== 'production' }" : ''
  return {
    key: 'database',
    legacyFiles: ['config/app.ts', ...providers],
    target: 'config/database.ts',
    content: `import { defineDatabaseConfig } from '@guren/core'\n\n// Name the dialect factory's result \`database\`, keep its named exports, and add:\nexport default defineDatabaseConfig(database${options})\n`,
    env: [],
    notes: ['defineDatabaseConfig() always connects the ORM at boot; bootModels() logic beyond that (a skipped or caught connection) does not carry over.'],
  }
}

function findCall(ast: File, callee: string): BabelNode | null {
  let found: BabelNode | null = null
  visit(ast.program, null, (node) => {
    if (found) return
    const target = node.callee as BabelNode | undefined
    if (node.type === 'CallExpression' && target?.type === 'Identifier' && target.name === callee) found = node
  })
  return found
}

/** The object a factory receives, directly or through top-level `const`s, with the declarations it needs. */
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
  const object = objectLiteral(unwrapped) ?? (viaConst && unwrapped.type === 'Identifier' ? objectLiteral(declaredInit(viaConst, unwrapped.name)) : null)
  if (!object) return null

  const needed = new Set<Node>()
  const pending: Node[] = [object]
  while (pending.length > 0) {
    visit(pending.pop(), null, (node) => {
      if (node.type !== 'Identifier') return
      const declaration = topLevel.get(node.name as string)
      if (declaration && !needed.has(declaration)) {
        needed.add(declaration)
        pending.push(declaration)
      }
    })
  }
  // The const the factory received is inlined as the object, so it is not declared again.
  const declarations = [...needed].filter((node) => node !== viaConst).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  return { object, declarations }
}

function declaredInit(declaration: Node | undefined, name: string): Node | undefined {
  if (declaration?.type !== 'VariableDeclaration') return undefined
  return declaration.declarations.find((declarator) => declarator.id.type === 'Identifier' && declarator.id.name === name)?.init ?? undefined
}

/** `process.env.X || 'y'` becomes `env.X` declared with its default; a bare read becomes optional. */
function rewriteEnvReads(source: string, nodes: readonly Node[]): Rewritten {
  const env = new Map<string, EnvDeclaration>()
  const pieces: string[] = []

  for (const node of nodes) {
    const start = node.start ?? 0
    const replacements: Span[] = []
    visit(node, null, (current, parent) => {
      const key = envKey(current)
      if (!key || key === 'NODE_ENV' || key.startsWith('GUREN_')) return
      const fallback = parent?.type === 'LogicalExpression' && (parent.operator === '||' || parent.operator === '??') && parent.left === current
        ? literal(parent.right as BabelNode)
        : undefined
      const span = fallback ? parent! : current
      replacements.push({ start: (span.start as number) - start, end: (span.end as number) - start, text: `env.${key}` })
      // `??` kept a blank value, which a default alone would replace.
      const blank = parent?.operator === '??' ? '.allowEmpty()' : ''
      if (fallback) env.set(key, { key, builder: `${fallback.builder}.default(${fallback.source})${blank}` })
      else if (!env.has(key)) env.set(key, { key, builder: 'Env.string().optional()' })
    })

    let text = source.slice(start, node.end ?? start)
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end)
    }
    pieces.push(dedent(text))
  }

  return { text: pieces.join('\n\n'), env }
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

function literal(node: BabelNode | undefined): { builder: string; source: string } | undefined {
  if (node?.type === 'StringLiteral') return { builder: 'Env.string()', source: JSON.stringify(node.value).replace(/^"|"$/g, "'") }
  if (node?.type === 'NumericLiteral') return { builder: 'Env.number()', source: String(node.value) }
  if (node?.type === 'BooleanLiteral') return { builder: 'Env.boolean()', source: String(node.value) }
  return undefined
}

/** The file's imports the definition body still references, with relative specifiers re-rooted at the target. */
function carriedImports(ast: File, source: string, body: string, from: string, to: string, dropped: readonly string[]): string[] {
  const lines: string[] = []
  const core: string[] = []
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    const specifier = statement.source.value
    const kept = statement.specifiers.filter((entry) => !dropped.includes(entry.local.name) && new RegExp(`\\b${entry.local.name}\\b`).test(body))
    if (kept.length === 0) continue

    if (specifier === '@guren/core' && kept.every((entry) => entry.type === 'ImportSpecifier')) {
      core.push(...kept.map((entry) => source.slice(entry.start ?? 0, entry.end ?? 0)))
      continue
    }
    const rerooted = specifier.startsWith('.')
      ? normalizeRelative(relative(dirname(to), resolve(dirname(from), specifier)))
      : specifier
    const names = kept.map((entry) => source.slice(entry.start ?? 0, entry.end ?? 0))
    const defaultName = kept.find((entry) => entry.type === 'ImportDefaultSpecifier')
    const named = names.filter((_, index) => kept[index] !== defaultName)
    const clause = [defaultName ? defaultName.local.name : null, named.length > 0 ? `{ ${named.join(', ')} }` : null].filter(Boolean).join(', ')
    lines.push(`import ${statement.importKind === 'type' ? 'type ' : ''}${clause} from '${rerooted}'`)
  }
  return [core.join(', '), ...lines]
}

function normalizeRelative(path: string): string {
  const posix = path.replace(/\\/g, '/')
  return posix.startsWith('.') ? posix : `./${posix}`
}

function renderDefinition(helper: string, imports: string[], body: Rewritten, declarationCount: number): string {
  const [core, ...rest] = imports
  const coreNames = [helper, ...(core ? [core] : [])].join(', ')
  const header = [`import { ${coreNames} } from '@guren/core'`, ...rest].join('\n')
  const parameter = body.env.size > 0 ? '(env)' : '()'
  const segments = body.text.split('\n\n')
  const object = segments.pop() ?? '{}'
  const callback = declarationCount === 0
    ? `${parameter} => (${object})`
    : `${parameter} => {\n${indent(segments.join('\n\n'))}\n\n  return ${object}\n}`
  return `${header}\n\nexport default ${helper}(${callback})\n`
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

function visit(value: unknown, parent: BabelNode | null, callback: (node: BabelNode, parent: BabelNode | null) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, parent, callback)
    return
  }
  if (value === null || typeof value !== 'object') return
  const node = value as BabelNode
  if (typeof node.type !== 'string') return
  callback(node, parent)
  for (const key in node) {
    if (key === 'loc' || key.endsWith('Comments')) continue
    visit(node[key], node, callback)
  }
}
