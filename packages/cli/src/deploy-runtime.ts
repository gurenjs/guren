import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { File } from '@babel/types'
import { memberKeyName, walk, type BabelNode } from './ast-walk'
import { resolveSessionDrivers, type SessionDriverRegistry } from './session-drivers'
import {
  collectFiles,
  toPosixRelative,
  IMPORTABLE_EXTENSIONS,
  NON_SOURCE_DIR_NAMES,
  formatTruncatedList,
  readRootSourceFiles,
} from './discovery'
import { parseSourceFile } from './parse-cache'
import { readDeclaredDependencyNames } from './plugin-manifest'
import type { CheckEvidence } from './check-result'
import { advisoryIntrospection, type Introspection } from './introspect'
// The runtime warning in the session middleware names the target by the same label.
import { SERVERLESS_RUNTIME_LABELS } from '@guren/server'
import type { AppManifest, AuthProviderEntry, DriverMapEntry, SessionEntry } from '@guren/server'
import { describeIntrospectionFailure, mapSection, NOT_INTROSPECTED_REASON, readManifestSection, UNVERIFIED_SECTION_FIX, type ManifestSection } from './manifest-section'

/**
 * Deploy targets whose runtime invalidates one or more of Guren's Bun-first
 * defaults. The prose versions of these warnings live in
 * packages/plugin-cloudflare/README.md and docs/{en,ja}/guides/serverless.md.
 */
type DeployTargetId = 'cloudflare' | 'vercel' | 'lambda'

export interface DeployTargetProfile {
  label: string
  /**
   * Whether `Bun.password` exists at runtime: only Workers (workerd) and
   * Lambda (Node.js) lose it, since Vercel functions run `runtime: 'bun1.x'`.
   * `DefaultHasher` writes scrypt everywhere (RFC 0003 §4); what breaks is an
   * explicit `new ScryptHasher()` or `hasher: 'argon2'`, whose Argon2id
   * cannot be read back.
   */
  hasBunRuntime: boolean
  /** Why filesystem-scanning provider discovery cannot work on this target. */
  discoveryBlocker: string
}

const DEPLOY_TARGET_PROFILES: Record<DeployTargetId, DeployTargetProfile> = {
  cloudflare: {
    label: SERVERLESS_RUNTIME_LABELS.cloudflare,
    hasBunRuntime: false,
    discoveryBlocker: 'Workers has no filesystem and no Bun runtime, so `Bun.Glob` scanning finds nothing.',
  },
  vercel: {
    label: SERVERLESS_RUNTIME_LABELS.vercel,
    hasBunRuntime: true,
    discoveryBlocker: 'The Vercel function is a `bun build` bundle that ships no `app/` directory to scan.',
  },
  lambda: {
    label: SERVERLESS_RUNTIME_LABELS.lambda,
    hasBunRuntime: false,
    discoveryBlocker: 'Lambda runs Node.js, where `Bun.Glob` is unavailable.',
  },
}

/**
 * Deploy plugin package names, matched against the app's own package.json.
 * Matched by name rather than off the `gurenPlugin` manifest, which lives in
 * `node_modules/` and so would not exist before `bun install`.
 */
const DEPLOY_PLUGIN_PACKAGES: Record<string, DeployTargetId> = {
  '@guren/plugin-cloudflare': 'cloudflare',
  '@guren/plugin-lambda': 'lambda',
  '@guren/plugin-vercel': 'vercel',
}

export interface DeployTargetDetection {
  profile: DeployTargetProfile
  /** Human-readable evidence, e.g. `@guren/plugin-cloudflare in package.json`. */
  detectedVia: string
}

/** A symbol match found while scanning app sources, with its location. */
export interface SourceSignal {
  symbol: string
  /** POSIX-relative path from the project root. */
  filePath: string
  line: number
}

/**
 * What the deploy verdicts read: the targets and the facts the manifest does not carry from
 * source, the hasher, session store and cache from the introspected app (RFC 0026 §5).
 */
export interface DeployRuntimeFacts {
  targets: DeployTargetDetection[]
  /**
   * `auth.attempt(...)`, `auth.useModel(...)` and `new ScryptHasher()`: password auth the source
   * shows, which keeps a manifest with no user provider from passing the hashing verdict.
   */
  passwordAuthSignals: SourceSignal[]
  /** `createSessionMiddleware(...)` calls: a session middleware mounted outside the manager the manifest describes. */
  sessionSignals: SourceSignal[]
  /** `autoSession: false` anywhere in the app — an explicit opt-out. */
  sessionDisabledSignals: SourceSignal[]
  /** Evidence that OAuth is used, which brings the OAuth state store with it. */
  oauthSignals: SourceSignal[]
  /** Database- or Redis-backed session stores — remediation for sessions. */
  backedSessionSignals: SourceSignal[]
  /** Database- or Redis-backed OAuth state stores. */
  backedOAuthSignals: SourceSignal[]
  /** Explicit `new Memory*Store()` / `new MemoryDriver()` constructions. */
  memoryStoreSignals: SourceSignal[]
  /** Explicit use of filesystem-scanning provider discovery. */
  discoverySignals: SourceSignal[]
  /**
   * Files that could not be read or parsed and therefore contributed no
   * signals. Surfaced in every deploy check message so a missed hazard is a
   * visible caveat, not a silent false negative. Covers *target* detection
   * too: the Lambda adapter is found in source, so a skipped file hides it.
   */
  unparsedFiles: string[]
  /**
   * What the introspected app reported for the sections a verdict reads (RFC 0026
   * §5). Absent when no introspection was asked for or it failed: the hashing and
   * store verdicts are then `-unverified`.
   */
  manifest?: DeployManifestFacts
  /** Why an introspection that was asked for gave no manifest, e.g. `import: Could not load src/main.ts`. */
  introspectionFailure?: string
}

/** What the deprecated {@link analyzeDeployRuntime} returns: the facts, plus six signal arrays that are always empty. */
export interface DeployRuntimeAnalysis extends DeployRuntimeFacts {
  /** @deprecated Always empty: the hasher is read from the introspected app. */
  bunOnlyHasherSignals: SourceSignal[]
  /** @deprecated Always empty: the hasher is read from the introspected app. */
  nodeHasherSignals: SourceSignal[]
  /** @deprecated Always empty: the hasher is read from the introspected app. */
  unreadableHasherSignals: SourceSignal[]
  /** @deprecated Always empty: the hasher is read from the introspected app. */
  unreadableConfigSignals: SourceSignal[]
  /** @deprecated Always empty: the session store is read from the introspected app. */
  unknownSessionDriverSignals: SourceSignal[]
  /** @deprecated Always empty: the session store is read from the introspected app. */
  memorySessionDefaultSignals: SourceSignal[]
}

export type ManifestHasher = Pick<AuthProviderEntry, 'hasher' | 'algorithm' | 'requiresBun'> & {
  /** The user provider holding it; null for the one `createApp({ auth })` writes with. */
  provider: string | null
}

/** The session store the app selects, as the manifest describes it. `perProcess` null: nothing installed says. */
export type ManifestSession =
  /** No store configured: the session middleware keeps sessions in memory. */
  | { kind: 'unconfigured' }
  | { kind: 'store'; name: string; driver: string; perProcess: boolean | null }
  /** A `default` naming a store the config does not declare. */
  | { kind: 'undeclared'; name: string }
  /** An `auth.sessionOptions.store` instance, by its class. */
  | { kind: 'class'; className: string; perProcess: boolean | null }
  /** An `auth.sessionOptions.store` factory, which only calling it would describe: judged by the stores the source constructs. */
  | { kind: 'scan' }

export interface DeployManifestFacts {
  /** Every hasher the auth manager holds: the one `createApp({ auth })` writes with, then each user provider's. */
  hashers: ManifestSection<ManifestHasher[]>
  /** Null when the app configures no session. */
  session: ManifestSection<ManifestSession | null>
  /**
   * The default cache store's label when its driver is `memory`, else null. No other
   * driver is judged: the scan never read a cache config, so none is claimed either way.
   */
  perProcessCache: ManifestSection<string | null>
}

export interface DeployRuntimeOptions {
  /**
   * The app's introspection, asked for only once a deploy target is found, so an app with
   * none never spawns it. Without one the hashing and store verdicts are `-unverified`:
   * `checkDeployRuntime()` introspects unless this is `false`, `readDeployRuntime()` only when given it.
   */
  introspect?: (() => Promise<Introspection>) | false
}

/** Where deploy code lives: the app's source trees plus the deploy plugins' `functions/` and `api/`. */
export const DEPLOY_SCAN_DIRS = ['src', 'app', 'config', 'db', 'routes', 'modules', 'bin', 'functions', 'api'] as const

/** Test files are excluded from the scan — see readAppSources. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/

// Every signal name is resolved through the file's own `@guren/*` value imports rather
// than matched bare, so `import { DatabaseSessionStore } from './my-own'` cannot satisfy a
// remediation; aliases and namespace imports resolve to canonical names. A local binding
// shadowing an imported signal name still counts, which only scope analysis would tell apart.

type SignalKind =
  | 'passwordAuth'
  | 'session'
  | 'sessionDisabled'
  | 'oauth'
  | 'backedSession'
  | 'backedOAuth'
  | 'memoryStore'
  | 'discovery'
  | 'lambda'

interface ExtractedSignal {
  kind: SignalKind
  symbol: string
  line: number
}

/**
 * Classes whose *construction* is a signal. A bare import never counts: it survives long
 * after the app stops using the thing it names, and must neither satisfy a remediation nor
 * raise a warning. `discover: true` in `createApp()` is inert, so not a signal.
 */
const CONSTRUCTED_SIGNALS: Record<string, SignalKind> = {
  DatabaseSessionStore: 'backedSession',
  RedisSessionStore: 'backedSession',
  DatabaseOAuthStateStore: 'backedOAuth',
  RedisOAuthStateStore: 'backedOAuth',
  MemorySessionStore: 'memoryStore',
  MemoryOAuthStateStore: 'memoryStore',
  MemoryApiTokenStore: 'memoryStore',
  MemoryPasswordResetStore: 'memoryStore',
  MemoryEmailVerificationStore: 'memoryStore',
  MemoryRateLimitStore: 'memoryStore',
  MemorySchedulerLock: 'memoryStore',
  MemoryStore: 'memoryStore',
  MemoryDriver: 'memoryStore',
  AutoDiscovery: 'discovery',
  ScryptHasher: 'passwordAuth',
}

/** Framework functions whose call is a signal. */
const CALLED_SIGNALS: Record<string, SignalKind> = {
  createSessionMiddleware: 'session',
  createOAuthManager: 'oauth',
  defineOAuthConfig: 'oauth',
  createLambdaHandler: 'lambda',
}

/**
 * Identifiers whose mere reference (outside an import declaration) is a signal:
 * OAuthServiceProvider is listed in `createApp({ providers })` rather than
 * constructed or called.
 */
const REFERENCED_SIGNALS: Record<string, SignalKind> = {
  OAuthServiceProvider: 'oauth',
}

const PASSWORD_AUTH_METHODS = new Set(['attempt', 'useModel'])

/** Only names imported from a Guren package resolve to a signal. */
const GUREN_PACKAGE_PREFIX = '@guren/'

/**
 * Type-only syntax, skipped wholesale so an identifier in a type position never
 * reads as usage. Nodes that merely *carry* a type while wrapping a real
 * expression (TSAsExpression, TSNonNullExpression, TSSatisfiesExpression) are
 * absent on purpose — their expression still has to be walked.
 */
const TYPE_ONLY_NODES = new Set([
  'TSTypeAnnotation',
  'TSTypeReference',
  'TSTypeQuery',
  'TSTypeParameterDeclaration',
  'TSTypeParameterInstantiation',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSDeclareFunction',
  'TSDeclareMethod',
  'TSModuleDeclaration',
  'TSIndexSignature',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'TSTypeLiteral',
  'TSQualifiedName',
  // `class X implements Y` / `interface A extends B`. A class's `extends`
  // clause is a plain expression on `superClass`, so it stays walkable.
  'TSExpressionWithTypeArguments',
])

/**
 * The Lambda adapter ships inside `@guren/core`/`@guren/server` rather than a
 * plugin package, so it is detected from these import sources.
 */
const LAMBDA_IMPORT_SOURCES = new Set(['@guren/core/lambda', '@guren/server/lambda'])

function lineOf(node: BabelNode): number {
  return node.loc?.start.line ?? 1
}

function propertyKeyName(property: BabelNode): string | null {
  const key = property.key as BabelNode | undefined
  if (!key) return null
  return memberKeyName({ computed: Boolean(property.computed), key }) ?? null
}

function extractSignals(ast: File): ExtractedSignal[] {
  // Local name → canonical exported name, for value imports from `@guren/*`
  // only, so a same-named export from another package resolves to nothing.
  const gurenNames = new Map<string, string>()
  const gurenNamespaces = new Set<string>()
  // Type-only imports included. `auth.attempt()` and `auth.useModel()`, resolved structurally
  // rather than through a binding, use this to stay inside Guren code.
  let importsGuren = false
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    if (!statement.source.value.startsWith(GUREN_PACKAGE_PREFIX)) continue
    importsGuren = true
    if (statement.importKind === 'type') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        if (specifier.importKind === 'type') continue
        const imported = specifier.imported
        gurenNames.set(specifier.local.name, imported.type === 'Identifier' ? imported.name : imported.value)
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        gurenNamespaces.add(specifier.local.name)
      }
    }
  }

  /**
   * Canonical Guren export name for a callee/identifier, or null. Covers plain
   * and aliased named imports plus `ns.Member` namespace access.
   */
  const resolve = (node: BabelNode | undefined): string | null => {
    if (!node) return null
    if (node.type === 'Identifier') return gurenNames.get(node.name as string) ?? null
    if (node.type === 'MemberExpression' && !node.computed) {
      const object = node.object as BabelNode
      const property = node.property as BabelNode
      if (
        object?.type === 'Identifier' &&
        property?.type === 'Identifier' &&
        gurenNamespaces.has(object.name as string)
      ) {
        return property.name as string
      }
    }
    return null
  }

  const signals: ExtractedSignal[] = []
  const seen = new Set<string>()
  const emit = (kind: SignalKind, symbol: string, line: number): void => {
    const key = `${kind}\x00${symbol}`
    if (seen.has(key)) return
    seen.add(key)
    signals.push({ kind, symbol, line })
  }

  walk(ast.program, (node) => {
    if (TYPE_ONLY_NODES.has(node.type)) return false

    switch (node.type) {
      case 'ImportDeclaration': {
        const source = node.source as BabelNode
        if (LAMBDA_IMPORT_SOURCES.has(source.value as string)) {
          emit('lambda', source.value as string, lineOf(node))
        }
        // Import specifiers are declarations, not usage — never signals.
        return false
      }

      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration': {
        if (node.exportKind === 'type') return false
        const source = node.source as BabelNode | null
        if (source && LAMBDA_IMPORT_SOURCES.has(source.value as string)) {
          emit('lambda', source.value as string, lineOf(node))
        }
        return
      }

      case 'NewExpression': {
        const name = resolve(node.callee as BabelNode)
        const kind = name ? CONSTRUCTED_SIGNALS[name] : undefined
        if (kind) emit(kind, name!, lineOf(node))
        return
      }

      case 'CallExpression': {
        const callee = node.callee as BabelNode
        const name = resolve(callee)

        if (name) {
          const kind = CALLED_SIGNALS[name]
          if (kind) emit(kind, name, lineOf(node))
        }

        if (callee?.type === 'MemberExpression') {
          // `auth.attempt(...)` verifies a password and `auth.useModel(...)` registers the provider
          // that hashes it. Resolved structurally, not through the import map: `auth` is a
          // controller property or a local the container resolved.
          const property = callee.property as BabelNode
          const object = callee.object as BabelNode
          const method = property?.type === 'Identifier' && PASSWORD_AUTH_METHODS.has(property.name as string) ? (property.name as string) : null
          const onAuth =
            (object?.type === 'Identifier' && object.name === 'auth') ||
            (object?.type === 'MemberExpression' &&
              (object.property as BabelNode)?.type === 'Identifier' &&
              (object.property as BabelNode).name === 'auth')
          if (method && onAuth && importsGuren) emit('passwordAuth', `auth.${method}`, lineOf(node))
        } else if (callee?.type === 'Import') {
          const first = (node.arguments as BabelNode[])[0]
          if (first?.type === 'StringLiteral' && LAMBDA_IMPORT_SOURCES.has(first.value as string)) {
            emit('lambda', first.value as string, lineOf(node))
          }
        }
        return
      }

      case 'ObjectProperty': {
        // Read whether or not the file imports from Guren: `autoSession: false` suppresses the
        // warning, and missing an opt-out warns a correctly-configured app.
        const value = node.value as BabelNode
        if (propertyKeyName(node) === 'autoSession' && value?.type === 'BooleanLiteral' && value.value === false) {
          emit('sessionDisabled', 'autoSession: false', lineOf(node))
        }
        return
      }

      case 'Identifier': {
        const name = resolve(node)
        if (name) {
          const kind = REFERENCED_SIGNALS[name]
          if (kind) emit(kind, name, lineOf(node))
        }
        return
      }
    }
  })

  return signals
}

interface ScannedFile {
  filePath: string
  signals: ExtractedSignal[]
}

/**
 * Read and signal-scan the app's own source files: DEPLOY_SCAN_DIRS plus any
 * source file in the project root. Test files are excluded — a fixture
 * constructing a backed store would otherwise satisfy the remediation check on
 * behalf of an app that never wires one up.
 */
async function readAppSources(cwd: string): Promise<{ files: ScannedFile[]; unparsed: string[] }> {
  const [directoryFiles, rootFiles] = await Promise.all([
    Promise.all(
      DEPLOY_SCAN_DIRS.map((dir) =>
        collectFiles(resolve(cwd, dir), IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES),
      ),
    ),
    readRootSourceFiles(cwd),
  ])

  const paths = [...rootFiles, ...directoryFiles.flat()].filter((path) => !TEST_FILE_PATTERN.test(path))

  // Signals are extracted inside the map so each AST is released as soon as its
  // file is reduced to signals. Not a ParseCache: no path in this list repeats,
  // so it would score zero hits while holding every AST alive to the end.
  const scanned = await Promise.all(
    paths.map(async (path) => {
      const filePath = toPosixRelative(cwd, path)
      const source = await readFile(path, 'utf8').catch(() => null)
      // An unreadable file is reported alongside an unparseable one: both
      // contribute no signals.
      if (source === null) return { filePath, signals: null }
      const ast = parseSourceFile(source, path)
      return { filePath, signals: ast ? extractSignals(ast) : null }
    }),
  )

  const files: ScannedFile[] = []
  const unparsed: string[] = []
  for (const { filePath, signals } of scanned) {
    if (signals === null) unparsed.push(filePath)
    else files.push({ filePath, signals })
  }

  return { files, unparsed }
}

/**
 * Deploy targets declared by the app: plugin packages from its package.json
 * dependencies, plus the Lambda adapter detected from source imports.
 */
function declaresDeployPlugin(declared: string[]): boolean {
  return declared.some((name) => Object.hasOwn(DEPLOY_PLUGIN_PACKAGES, name))
}

function detectDeployTargets(declared: string[], files: ScannedFile[]): DeployTargetDetection[] {
  const detections: DeployTargetDetection[] = []

  for (const [packageName, targetId] of Object.entries(DEPLOY_PLUGIN_PACKAGES)) {
    if (declared.includes(packageName)) {
      detections.push({
        profile: DEPLOY_TARGET_PROFILES[targetId],
        detectedVia: `${packageName} in package.json`,
      })
    }
  }

  // A hand-rolled deploy can import the adapter without installing the plugin.
  // Skipped when the plugin already declared the target: it also scaffolds
  // src/lambda.ts, and reporting Lambda twice doubles every warning.
  if (!detections.some((detection) => detection.profile === DEPLOY_TARGET_PROFILES.lambda)) {
    const lambdaFile = files.find((file) => file.signals.some((signal) => signal.kind === 'lambda'))
    if (lambdaFile) {
      detections.push({
        profile: DEPLOY_TARGET_PROFILES.lambda,
        detectedVia: `Lambda adapter imported in ${lambdaFile.filePath}`,
      })
    }
  }

  return detections
}

/**
 * What the deploy verdicts read: the targets and the facts only the source holds, then the
 * introspected app once a target is found. `guren doctor` and {@link checkDeployRuntime} call it.
 */
export async function readDeployRuntime(cwd: string, options: DeployRuntimeOptions = {}): Promise<DeployRuntimeFacts> {
  const declared = await readDeclaredDependencyNames(cwd)
  // A declared plugin is a target before any file is parsed, so the child overlaps the scan.
  const early = options.introspect && declaresDeployPlugin(declared) ? options.introspect() : undefined
  const { files, unparsed } = await readAppSources(cwd)
  const targets = detectDeployTargets(declared, files)
  const introspection = options.introspect && targets.length > 0 ? await (early ?? options.introspect()) : undefined

  const collect = (kind: SignalKind): SourceSignal[] =>
    files.flatMap((file) =>
      file.signals
        .filter((signal) => signal.kind === kind)
        .map((signal) => ({ symbol: signal.symbol, filePath: file.filePath, line: signal.line })),
    )

  return {
    targets,
    passwordAuthSignals: collect('passwordAuth'),
    sessionSignals: collect('session'),
    sessionDisabledSignals: collect('sessionDisabled'),
    oauthSignals: collect('oauth'),
    backedSessionSignals: collect('backedSession'),
    backedOAuthSignals: collect('backedOAuth'),
    memoryStoreSignals: collect('memoryStore'),
    discoverySignals: collect('discovery'),
    unparsedFiles: unparsed,
    // Resolving a plugin's session driver reads node_modules, which only the manifest's store needs.
    ...(introspection?.status === 'ok' ? { manifest: readDeployManifestFacts(introspection.manifest, await resolveSessionDrivers(cwd)) } : {}),
    ...(introspection?.status === 'failed'
      ? { introspectionFailure: describeIntrospectionFailure(introspection) }
      : {}),
  }
}

/** `analyzeDeployRuntime` and `judgeDeployRuntime`, which `checkDeployRuntime` replaces. */
export const DEPLOY_RUNTIME_ANALYSIS_DEPRECATION = {
  id: 'deploy-runtime-analysis',
  since: '2.28.0',
  removedIn: '3.0.0',
  replacement: 'Call checkDeployRuntime(cwd), which introspects the app and returns the three verdicts.',
} as const

const warnedSymbols = new Set<string>()

/** The deprecation policy's warning, once per symbol per process. */
function warnDeprecated(symbol: string): void {
  if (warnedSymbols.has(symbol)) return
  warnedSymbols.add(symbol)
  const { id, since, removedIn, replacement } = DEPLOY_RUNTIME_ANALYSIS_DEPRECATION
  console.warn(`[guren] Deprecation (${id}): ${symbol}() is deprecated\n  since ${since}, will be removed in ${removedIn}.\n  ${replacement}`)
}

/**
 * @deprecated Use {@link checkDeployRuntime}. Introspects the app unless `options.introspect`
 * is `false`, as `checkDeployRuntime` does. Removed in `@guren/cli` 3.0.0.
 */
export async function analyzeDeployRuntime(cwd: string, options: DeployRuntimeOptions = {}): Promise<DeployRuntimeAnalysis> {
  warnDeprecated('analyzeDeployRuntime')
  const facts = await readDeployRuntime(cwd, { introspect: options.introspect ?? advisoryIntrospection(cwd) })
  return {
    ...facts,
    bunOnlyHasherSignals: [],
    nodeHasherSignals: [],
    unreadableHasherSignals: [],
    unreadableConfigSignals: [],
    unknownSessionDriverSignals: [],
    memorySessionDefaultSignals: [],
  }
}

export function readDeployManifestFacts(manifest: AppManifest, drivers: SessionDriverRegistry): DeployManifestFacts {
  return {
    hashers: mapSection(readManifestSection(manifest, 'auth'), (auth) =>
      auth === undefined
        ? []
        : [
            { provider: null, hasher: auth.hasher, algorithm: auth.algorithm, requiresBun: auth.requiresBun },
            ...Object.entries(auth.providers).map(([name, { hasher, algorithm, requiresBun }]) => ({
              provider: name,
              hasher,
              algorithm,
              requiresBun,
            })),
          ],
    ),
    session: mapSection(readManifestSection(manifest, 'session'), (session) =>
      session === undefined ? null : sessionStoreOf(session, drivers),
    ),
    perProcessCache: mapSection(readManifestSection(manifest, 'cache'), (cache) => (cache === undefined ? null : perProcessCacheOf(cache))),
  }
}

function sessionStoreOf(session: SessionEntry, drivers: SessionDriverRegistry): ManifestSession {
  if (session.source === 'none') return { kind: 'unconfigured' }
  const store = session.stores[session.default]
  if (session.source === 'auth.sessionOptions.store') {
    // `driver` is the store's constructor name here, never a driver name a plugin could declare.
    return store?.driver ? { kind: 'class', className: store.driver, perProcess: store.perProcess } : { kind: 'scan' }
  }
  if (!store?.driver) return { kind: 'undeclared', name: session.default }
  const { driver } = store
  // The manifest knows the framework's drivers; an installed plugin's manifest knows its own.
  const perProcess = store.perProcess ?? (drivers.has(driver) ? !drivers.get(driver) : null)
  return { kind: 'store', name: session.default, driver, perProcess }
}

function perProcessCacheOf(cache: DriverMapEntry): string | null {
  return cache.entries[cache.default]?.driver === 'memory' ? `the '${cache.default}' cache store (driver \`memory\`)` : null
}

/** Caveat appended to a check message when the scan was incomplete. */
export function formatParseCaveat(analysis: DeployRuntimeFacts): string {
  const { unparsedFiles } = analysis
  if (unparsedFiles.length === 0) return ''

  const shown = formatTruncatedList(unparsedFiles)
  return ` Note: ${unparsedFiles.length} file(s) could not be read or parsed and were not scanned: ${shown}.`
}

/** Targets that lack `Bun.password`, so an explicit `ScryptHasher` breaks. */
export function bunlessTargets(analysis: DeployRuntimeFacts): DeployTargetDetection[] {
  return analysis.targets.filter((target) => !target.profile.hasBunRuntime)
}

export function formatTargetLabels(targets: DeployTargetDetection[]): string {
  return targets.map((target) => target.profile.label).join(', ')
}

export function formatSignals(signals: SourceSignal[]): string {
  const unique = new Map<string, SourceSignal>()
  for (const signal of signals) {
    if (!unique.has(signal.symbol)) {
      unique.set(signal.symbol, signal)
    }
  }

  return [...unique.values()]
    .map((signal) => `${signal.symbol} (${signal.filePath}:${signal.line})`)
    .join(', ')
}

export type DeployRuntimeVerdictStatus = 'pass' | 'warn'

type DeployRuntimeCheckKey = 'deploy-password-hashing' | 'deploy-runtime-stores' | 'deploy-provider-discovery'

/**
 * One deploy-runtime verdict, shaped for every consumer: `guren doctor` maps it
 * onto a DoctorCheck, `guren check` onto an advisory CheckResult, and the
 * deploy builds print it (RFC 0020 Part 0). A passing verdict carries no `fix`.
 * The `-unverified` key is a verdict resting on a manifest fact that could not be
 * trusted and has no static path (RFC 0026 §5): always a warn, with `evidence: 'none'`.
 */
export interface DeployRuntimeVerdict {
  key: DeployRuntimeCheckKey | `${DeployRuntimeCheckKey}-unverified`
  title: string
  status: DeployRuntimeVerdictStatus
  message: string
  fix?: string
  evidence: CheckEvidence
  /** Why the introspected app could not vouch for an `-unverified` verdict. */
  evidenceReason?: string
}

function verdict(
  key: DeployRuntimeVerdict['key'],
  title: string,
  status: DeployRuntimeVerdictStatus,
  message: string,
  evidence: CheckEvidence,
  fix?: string,
): DeployRuntimeVerdict {
  return status === 'pass' ? { key, title, status, message, evidence } : { key, title, status, message, fix, evidence }
}

const UNVERIFIED_FIX = `${UNVERIFIED_SECTION_FIX} This check never fails a build.`

const BUN_ONLY_HASHER_FIX = "Drop `hasher: 'argon2'`, or replace `new ScryptHasher()` with `new Hash()`: the default writes `node:crypto` scrypt, which every runtime reads back. Rows already written as Argon2id are rehashed on their next successful login under Bun, so have them log in there first (or reset those passwords) before this runtime has to verify them."

/**
 * Why the introspected app has no fact for a section: the section's own reason, the failed run,
 * or no run at all. `undefined` when the manifest describes it.
 */
function unverifiedReason<T>(analysis: DeployRuntimeFacts, section: ManifestSection<T> | undefined): string | undefined {
  if (section) return section.status === 'unverified' ? section.reason : undefined
  return analysis.introspectionFailure ? `introspection failed with ${analysis.introspectionFailure}` : NOT_INTROSPECTED_REASON
}

/**
 * `DefaultHasher` writes `node:crypto` scrypt on every runtime, which workerd's `nodejs_compat`
 * implements in full (RFC 0003 §4), so password auth alone does not break on a Bun-less target.
 * What breaks is an explicit Bun.password selection (`new ScryptHasher()`, `hasher: 'argon2'`).
 * The hashers are the introspected app's (RFC 0026 §5); without them this is `-unverified`.
 */
function judgePasswordHashing(analysis: DeployRuntimeFacts): DeployRuntimeVerdict {
  const key = 'deploy-password-hashing'
  const title = 'Deploy Password Hashing'

  const bunless = bunlessTargets(analysis)
  // Every verdict carries the parse caveat, target-only ones included: the
  // Lambda adapter is detected from source, so a skipped file can turn a real
  // warning into "no deploy target detected".
  const caveat = formatParseCaveat(analysis)
  if (bunless.length === 0) {
    return verdict(
      key,
      title,
      'pass',
      analysis.targets.length > 0
        ? `${formatTargetLabels(analysis.targets)} runs on Bun, so every built-in hasher applies.${caveat}`
        : `No deploy plugin or Lambda adapter detected.${caveat}`,
      'static',
    )
  }

  const labels = formatTargetLabels(bunless)
  const hashers = analysis.manifest?.hashers
  const described = hashers?.status === 'described' ? hashers.value : undefined
  const reason = described ? unregisteredProviderReason(analysis, described) : unverifiedReason(analysis, hashers)
  if (reason === undefined) return judgeManifestHashing(analysis, described!, labels, caveat)
  return {
    ...verdict(
      `${key}-unverified`,
      title,
      'warn',
      `${labels} detected, and which hashers the app registers is unverified: ${reason}. Whether they write node:crypto scrypt or Bun-only Argon2id is unknown, so this is not a pass.${caveat}`,
      'none',
      `${UNVERIFIED_FIX} Until then, confirm the app selects no \`hasher: 'argon2'\` and constructs no \`ScryptHasher\`.`,
    ),
    evidenceReason: reason,
  }
}

const UNKNOWN_HASHER_FIX = "A hasher of the app's own, a subclass of a framework one, or a custom user provider can override `hash()`, so the manifest reports no format for it. Confirm it does not write through Bun.password (Argon2id or bcrypt). This check never fails a build, so an app whose hasher is correct can leave it."

function formatHashers(hashers: ManifestHasher[]): string {
  return hashers
    .map((entry) => {
      const where = entry.provider === null ? 'createApp({ auth })' : `user provider '${entry.provider}'`
      return `${where}: ${entry.hasher ?? 'custom'}${entry.algorithm ? ` (${entry.algorithm})` : ''}`
    })
    .join(', ')
}

/**
 * Why hashers the app registered cannot settle the verdict: all scrypt, none a user provider's, yet
 * the source shows password auth, which a `useModel()` in a provider's `boot()` would explain.
 */
function unregisteredProviderReason(analysis: DeployRuntimeFacts, hashers: ManifestHasher[]): string | undefined {
  const settled = hashers.some((entry) => entry.requiresBun !== false || entry.provider !== null)
  if (settled || analysis.passwordAuthSignals.length === 0) return undefined
  return `the source shows password auth (${formatSignals(analysis.passwordAuthSignals)}), but the app registers no user provider, which a useModel() in a provider's boot() would explain`
}

function judgeManifestHashing(
  analysis: DeployRuntimeFacts,
  hashers: ManifestHasher[],
  labels: string,
  caveat: string,
): DeployRuntimeVerdict {
  const key = 'deploy-password-hashing'
  const title = 'Deploy Password Hashing'

  const bunOnly = hashers.filter((entry) => entry.requiresBun === true)
  if (bunOnly.length > 0) {
    return verdict(
      key,
      title,
      'warn',
      `${labels} detected, but a Bun-only hasher is registered (${formatHashers(bunOnly)}). It hashes through Bun.password, so the rows it writes cannot be verified on this runtime.${caveat}`,
      'manifest',
      BUN_ONLY_HASHER_FIX,
    )
  }

  const unknown = hashers.filter((entry) => entry.requiresBun === null)
  if (unknown.length > 0) {
    return verdict(
      key,
      title,
      'warn',
      `${labels} detected, and whether these hashers need Bun.password is unverified (${formatHashers(unknown)}). Whether they write node:crypto scrypt or Bun-only Argon2id is unknown, so this is not a pass.${caveat}`,
      'manifest',
      UNKNOWN_HASHER_FIX,
    )
  }

  if (hashers.every((entry) => entry.provider === null)) {
    return verdict(
      key,
      title,
      'pass',
      `${labels} detected, and neither the registered app nor its source shows password authentication.${caveat}`,
      'manifest',
    )
  }

  return verdict(
    key,
    title,
    'pass',
    `${labels} detected, and every registered hasher writes node:crypto scrypt (${formatHashers(hashers)}).${caveat}`,
    'manifest',
  )
}

const BACKED_STORE_FIX = 'Run `bunx guren add session` for a database-backed session store, use DatabaseOAuthStateStore from `@guren/core` (or the Redis equivalent from `@guren/core/redis`) for OAuth state, and a Redis-backed cache/queue driver.'

const OAUTH_STATE_STORE_FIX = 'Bind the OAuth manager yourself with `createOAuthManager({ stateStore: new DatabaseOAuthStateStore(oauthStates) })` from `@guren/core`, over an `oauth_states` table in db/schema.ts (the columns are in the OAuth guide), or with RedisOAuthStateStore from `@guren/core/redis`, and drop OAuthServiceProvider from the providers, since it binds the in-memory default. A `config/oauth.ts` definition takes the same store as `stateStore` in what `defineOAuthConfig` resolves.'

/** Memory stores whose remedy is narrower than BACKED_STORE_FIX; every other one gets that. */
const MEMORY_STORE_FIXES: Record<string, string> = {
  MemoryOAuthStateStore: OAUTH_STATE_STORE_FIX,
}

const UNKNOWN_MANIFEST_DRIVER_FIX = 'A driver registered in application code is not one the framework knows, and a plugin declares its own in `gurenPlugin.drivers.session`. This check never fails a build, so an app whose driver is correct can leave it.'

const STORE_CLASS_FIX = "The manifest knows only the framework's session store classes. Confirm this one keeps sessions outside process memory (a database, Redis, or a platform binding). This check never fails a build, so an app whose store is correct can leave it."

const UNDECLARED_STORE_FIX = 'Declare the store under `stores` in the session config, or point `default` (often `SESSION_DRIVER`) at a store it declares: the session manager refuses an undeclared default when it is built.'

type RaiseIssue = (issue: string, fix: string) => void

/**
 * An `auth.sessionOptions.store` factory, which the manifest cannot call: judged by whether
 * the source constructs a database or Redis store for it.
 */
function raiseFactorySessionIssues(analysis: DeployRuntimeFacts, raise: RaiseIssue): void {
  // The manifest already shows the factory, so a session signal in source is not asked for.
  if (analysis.backedSessionSignals.length === 0 && analysis.sessionDisabledSignals.length === 0) {
    raise('sessions use an auth.sessionOptions.store factory, and no DatabaseSessionStore or RedisSessionStore is constructed', BACKED_STORE_FIX)
  }
}

/**
 * The session store as the introspected app configured it, read with this environment's
 * `.env`. A session middleware mounted by hand (`createSessionMiddleware`) is outside
 * the manager, so it stays on the scan.
 */
function raiseManifestSessionIssues(analysis: DeployRuntimeFacts, session: ManifestSession | null, raise: RaiseIssue): void {
  if (session === null) {
    const manual = analysis.sessionSignals
    if (manual.length > 0 && analysis.backedSessionSignals.length === 0 && analysis.sessionDisabledSignals.length === 0) {
      raise(
        `sessions are enabled (${formatSignals(manual)}) with no persistent store: no DatabaseSessionStore or RedisSessionStore is constructed`,
        BACKED_STORE_FIX,
      )
    }
    return
  }
  if (session.kind === 'scan') return raiseFactorySessionIssues(analysis, raise)
  if (analysis.sessionDisabledSignals.length > 0) return

  switch (session.kind) {
    case 'unconfigured':
      return raise('sessions are enabled with no session store configured, so the session middleware keeps them in per-process memory', BACKED_STORE_FIX)
    case 'undeclared':
      return raise(`the session config's \`default\` names '${session.name}', a store it does not declare`, UNDECLARED_STORE_FIX)
    case 'store': {
      const label = `the '${session.name}' session store (driver \`${session.driver}\`)`
      if (session.perProcess === true) return raise(`sessions use ${label} in this environment, which is per-process`, BACKED_STORE_FIX)
      if (session.perProcess === null) {
        return raise(
          `sessions use ${label}, which this check cannot vouch for, being neither built in nor declared by an installed plugin's \`gurenPlugin.drivers.session\``,
          UNKNOWN_MANIFEST_DRIVER_FIX,
        )
      }
      return
    }
    case 'class': {
      const label = `auth.sessionOptions.store (${session.className})`
      if (session.perProcess === true) return raise(`sessions use ${label}, which is per-process`, BACKED_STORE_FIX)
      if (session.perProcess === null) return raise(`sessions use ${label}, a store class this check cannot vouch for`, STORE_CLASS_FIX)
      return
    }
  }
}

/**
 * Serverless targets share no memory between invocations, so in-memory stores
 * drop every session, cache entry, queued job, and OAuth state in production
 * while working perfectly in local development. The session and cache stores are
 * the introspected app's; without them the verdict is `-unverified`, still naming
 * what the source shows (explicit constructions, OAuth state).
 */
function judgeRuntimeStores(analysis: DeployRuntimeFacts): DeployRuntimeVerdict {
  const key = 'deploy-runtime-stores'
  const title = 'Deploy Runtime Stores'

  const caveat = formatParseCaveat(analysis)

  if (analysis.targets.length === 0) {
    return verdict(key, title, 'pass', `No deploy plugin or Lambda adapter detected.${caveat}`, 'static')
  }

  const sessionSection = analysis.manifest?.session
  const cacheSection = analysis.manifest?.perProcessCache
  const session = sessionSection?.status === 'described' ? sessionSection.value : undefined

  const labels = formatTargetLabels(analysis.targets)
  const issues: string[] = []
  // Each issue names the remedy that fits it, deduped in order: telling an app
  // that deliberately registered a driver to install a database store instead
  // is the wrong advice, and the generic fix says exactly that.
  const fixes: string[] = []
  const raise: RaiseIssue = (issue, fix) => {
    issues.push(issue)
    if (!fixes.includes(fix)) fixes.push(fix)
  }

  const memoryStoresByFix = new Map<string, SourceSignal[]>()
  for (const signal of analysis.memoryStoreSignals) {
    // The manifest names the session store the app actually selected.
    if (session && session.kind !== 'scan' && signal.symbol === 'MemorySessionStore') continue
    const fix = MEMORY_STORE_FIXES[signal.symbol] ?? BACKED_STORE_FIX
    memoryStoresByFix.set(fix, [...(memoryStoresByFix.get(fix) ?? []), signal])
  }
  for (const [fix, signals] of memoryStoresByFix) {
    raise(`in-memory stores are constructed explicitly (${formatSignals(signals)})`, fix)
  }

  if (session !== undefined) raiseManifestSessionIssues(analysis, session, raise)

  if (cacheSection?.status === 'described' && cacheSection.value !== null) {
    raise(`the cache uses ${cacheSection.value} in this environment, which is per-process`, BACKED_STORE_FIX)
  }

  if (analysis.oauthSignals.length > 0 && analysis.backedOAuthSignals.length === 0) {
    raise(
      `OAuth is configured (${formatSignals(analysis.oauthSignals)}) with no DatabaseOAuthStateStore or RedisOAuthStateStore`,
      OAUTH_STATE_STORE_FIX,
    )
  }

  const unverified = [
    { store: 'session', reason: unverifiedReason(analysis, sessionSection) },
    { store: 'cache', reason: unverifiedReason(analysis, cacheSection) },
  ].filter((entry): entry is { store: string; reason: string } => entry.reason !== undefined)
  if (unverified.length > 0) {
    const stores = unverified.map((entry) => entry.store).join(' and ')
    const reasons = [...new Set(unverified.map((entry) => entry.reason))]
    const also = issues.length > 0 ? `; beyond that, ${issues.join('; ')}` : ''
    return {
      ...verdict(
        `${key}-unverified`,
        title,
        'warn',
        `${labels} shares no memory between requests, but whether the ${stores} ${unverified.length > 1 ? 'stores are' : 'store is'} per-process is unverified: ${reasons.join('; ')}${also}.${caveat}`,
        'none',
        [UNVERIFIED_FIX, ...fixes].join(' '),
      ),
      evidenceReason: reasons.join('; '),
    }
  }

  // Past the unverified return the session is described: only a factory is judged by what the source constructs.
  const evidence: CheckEvidence = session?.kind === 'scan' ? 'static' : 'manifest'
  return issues.length === 0
    ? verdict(key, title, 'pass', `${labels} detected, and no in-memory store defaults were found.${caveat}`, evidence)
    : verdict(key, title, 'warn', `${labels} shares no memory between requests, but ${issues.join('; ')}.${caveat}`, evidence, fixes.join(' '))
}

const EXPLICIT_PROVIDERS_FIX = 'List providers explicitly in `createApp({ providers: [...] })` instead of discovering them from the filesystem.'

/**
 * `AutoDiscovery` scans directories with `Bun.Glob` and imports what it finds.
 * Every deploy target breaks that, either by having no Bun runtime or by
 * shipping a bundle with no source tree to scan. Always judged from source: a
 * provider it finds registers as `app.register`, as an explicit
 * `app.register(X)` does, and the listeners and jobs it finds are not in the manifest.
 */
function judgeProviderDiscovery(analysis: DeployRuntimeFacts): DeployRuntimeVerdict {
  const key = 'deploy-provider-discovery'
  const title = 'Deploy Provider Discovery'

  const caveat = formatParseCaveat(analysis)

  if (analysis.targets.length === 0) {
    return verdict(key, title, 'pass', `No deploy plugin or Lambda adapter detected.${caveat}`, 'static')
  }

  const labels = formatTargetLabels(analysis.targets)

  if (analysis.discoverySignals.length === 0) {
    return verdict(key, title, 'pass', `${labels} detected, and provider discovery is not used.${caveat}`, 'static')
  }

  const blockers = analysis.targets.map((target) => `${target.profile.label}: ${target.profile.discoveryBlocker}`)

  return verdict(
    key,
    title,
    'warn',
    `${labels} detected, but the app uses filesystem provider discovery (${formatSignals(analysis.discoverySignals)}). ${blockers.join(' ')}${caveat}`,
    'static',
    EXPLICIT_PROVIDERS_FIX,
  )
}

/** The three deploy-runtime verdicts over one analysis, in report order. */
export function judgeDeployVerdicts(analysis: DeployRuntimeFacts): DeployRuntimeVerdict[] {
  return [judgePasswordHashing(analysis), judgeRuntimeStores(analysis), judgeProviderDiscovery(analysis)]
}

/** @deprecated Use {@link checkDeployRuntime}. Removed in `@guren/cli` 3.0.0. */
export function judgeDeployRuntime(analysis: DeployRuntimeAnalysis): DeployRuntimeVerdict[] {
  warnDeprecated('judgeDeployRuntime')
  return judgeDeployVerdicts(analysis)
}

/**
 * Scan and judge in one call: what a deploy build runs before the app build.
 * Empty when the app declares no deploy target, so a caller prints nothing
 * for an app this cannot apply to; every verdict is present otherwise, passing
 * ones included, since the build may want to say what it verified. Reads the
 * introspected app unless `options` says otherwise.
 */
export async function checkDeployRuntime(
  cwd: string,
  options: DeployRuntimeOptions = {},
): Promise<DeployRuntimeVerdict[]> {
  const analysis = await readDeployRuntime(cwd, { introspect: options.introspect ?? advisoryIntrospection(cwd) })
  return analysis.targets.length === 0 ? [] : judgeDeployVerdicts(analysis)
}
