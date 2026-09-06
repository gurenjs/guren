import { readFile, readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { File, Node, ObjectExpression } from '@babel/types'
import { memberKeyName, objectLiteral, walk, type BabelNode } from './ast-walk'
import { DEFAULT_SESSION_STORE_NAME, PER_PROCESS_SESSION_DRIVERS, readSessionConfig, sessionConfigsIn } from './session-config'
import {
  collectFiles,
  toPosixRelative,
  IMPORTABLE_EXTENSIONS,
  NON_SOURCE_DIR_NAMES,
  formatTruncatedList,
} from './discovery'
import { parseSourceFile } from './parse-cache'
import { readDeclaredDependencyNames } from './plugin-manifest'
// The runtime warning in the session middleware names the target by the same label.
import { SERVERLESS_RUNTIME_LABELS } from '@guren/core'

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
   * `DefaultHasher` does not depend on it (RFC 0003 §4); what breaks is an
   * explicit `new ScryptHasher()`, whose Argon2id cannot be read back.
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

export interface DeployRuntimeAnalysis {
  targets: DeployTargetDetection[]
  passwordAuthSignals: SourceSignal[]
  /** `ScryptHasher` constructions — a hash format only Bun can read back. */
  bunOnlyHasherSignals: SourceSignal[]
  /** Hashers that work without `Bun.password`: `NodeHasher`, `Hash`. */
  nodeHasherSignals: SourceSignal[]
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
  /** A session config that selects the per-process `memory` store. */
  memorySessionDefaultSignals: SourceSignal[]
  /** Explicit use of filesystem-scanning provider discovery. */
  discoverySignals: SourceSignal[]
  /**
   * Files that could not be read or parsed and therefore contributed no
   * signals. Surfaced in every deploy check message so a missed hazard is a
   * visible caveat, not a silent false negative. Covers *target* detection
   * too: the Lambda adapter is found in source, so a skipped file hides it.
   */
  unparsedFiles: string[]
}

const DEPLOY_SCAN_DIRS = ['src', 'app', 'config', 'db', 'routes', 'modules', 'bin', 'functions', 'api'] as const

/** Test files are excluded from the scan — see readAppSources. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/

// Every signal name is resolved through the file's own `@guren/*` value imports rather
// than matched bare, so `import { NodeHasher } from './my-own'` cannot satisfy a
// remediation; aliases and namespace imports resolve to canonical names. Limitations
// needing scope/dataflow analysis: a local binding shadowing an imported signal name
// still counts, and an options object built elsewhere and passed to createApp is not seen (its keys are).

type SignalKind =
  | 'passwordAuth'
  | 'bunOnlyHasher'
  | 'nodeHasher'
  | 'session'
  | 'sessionDisabled'
  | 'oauth'
  | 'backedSession'
  | 'backedOAuth'
  | 'memoryStore'
  | 'discovery'
  | 'lambda'
  /** A session config whose selected store is the per-process `memory` driver. */
  | 'memorySessionDefault'

interface ExtractedSignal {
  kind: SignalKind
  symbol: string
  line: number
}

/**
 * Classes whose *construction* is a signal. A bare import never counts: it survives long
 * after the app stops using the thing it names, and must neither satisfy a remediation nor
 * raise a warning. ScryptHasher is `bunOnlyHasher` because it pins the app to a format only
 * `Bun.password` can read; `DefaultHasher`/`Hash` are remediation because they pick their
 * delegate from the runtime and the stored hash. `discover: true` in `createApp()` is inert, so not a signal.
 */
const CONSTRUCTED_SIGNALS: Record<string, SignalKind> = {
  ScryptHasher: 'bunOnlyHasher',
  NodeHasher: 'nodeHasher',
  DefaultHasher: 'nodeHasher',
  Hash: 'nodeHasher',
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
  MemoryStore: 'memoryStore',
  MemoryDriver: 'memoryStore',
  AutoDiscovery: 'discovery',
}

/** Framework functions whose call is a signal. */
const CALLED_SIGNALS: Record<string, SignalKind> = {
  createSessionMiddleware: 'session',
  createOAuthManager: 'oauth',
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
  // Type-only imports included. The two signals resolved structurally rather
  // than through a binding — `auth.attempt()` and the session option keys —
  // use this to stay inside Guren code.
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

  /**
   * Whether the store a `SessionConfig` selects shares state between requests.
   * The candidates are the one `default` names, or — when `default` is written
   * but unreadable — every declared store, since the environment cannot select
   * what is not declared. An unreadable *driver* is a candidate nothing can
   * vouch for, so it blocks that shortcut.
   */
  const emitSessionConfig = (config: ObjectExpression, line: number): void => {
    const { declaresDefault, selected, stores } = readSessionConfig(config)

    // An absent `default` is not an unknown one: SessionManager resolves it to
    // the per-process store, so the config selects memory without saying so.
    const chosen = declaresDefault ? selected : DEFAULT_SESSION_STORE_NAME
    let candidates: Array<string | undefined>
    let label: string

    if (chosen !== undefined) {
      // `memory` is declared by SessionManager whether or not the config lists
      // it, so a default naming it is a selection even with no matching entry.
      candidates = [stores.has(chosen) ? stores.get(chosen) : chosen]
      label = declaresDefault ? `SessionConfig default: '${chosen}'` : 'SessionConfig with no default'
    } else {
      candidates = [...stores.values()]
      label = `SessionConfig stores: ${[...stores.keys()].join(', ')}`
    }

    if (candidates.length === 0) return
    if (candidates.every((driver) => driver !== undefined && !PER_PROCESS_SESSION_DRIVERS.has(driver))) {
      emit('backedSession', label, line)
    } else if (candidates.every((driver) => driver !== undefined && PER_PROCESS_SESSION_DRIVERS.has(driver))) {
      emit('memorySessionDefault', label, line)
    }
  }

  // Found through the shared reader rather than the walk below: the anchor is
  // a type annotation, and the walk skips type-only nodes by design.
  for (const { config, line } of sessionConfigsIn(ast)) emitSessionConfig(config, line)

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
        if (name) {
          const kind = CONSTRUCTED_SIGNALS[name]
          if (kind) emit(kind, name, lineOf(node))
        }
        return
      }

      case 'CallExpression': {
        const callee = node.callee as BabelNode
        const name = resolve(callee)

        if (name) {
          const kind = CALLED_SIGNALS[name]
          if (kind) emit(kind, name, lineOf(node))

          // An `auth` key in createApp's options enables sessions:
          // AuthServiceProvider attaches session middleware whenever
          // `options.auth` is present and autoSession isn't explicitly false.
          // Scoped to createApp so SMTP-style `auth: { user, pass }` mailer
          // config does not read as a session.
          if (name === 'createApp') {
            // Unlike the generic identifier scan, this positional read has to
            // unwrap `satisfies`/`as const` itself.
            const options = objectLiteral((node.arguments as Node[])[0])
            if (options) {
              for (const property of options.properties as unknown as BabelNode[]) {
                if (property.type === 'ObjectProperty' && propertyKeyName(property) === 'auth') {
                  emit('session', 'auth', lineOf(property))
                }
              }
            }
          }
        }

        if (callee?.type === 'MemberExpression') {
          // `auth.attempt(...)` is the entry point app code calls to verify a
          // password. Resolved structurally, not through the import map: `auth`
          // here is a controller property. Known gap: a registration-only app
          // that never calls attempt() passes undetected.
          const property = callee.property as BabelNode
          const object = callee.object as BabelNode
          const isAttempt = property?.type === 'Identifier' && property.name === 'attempt'
          const onAuth =
            (object?.type === 'Identifier' && object.name === 'auth') ||
            (object?.type === 'MemberExpression' &&
              (object.property as BabelNode)?.type === 'Identifier' &&
              (object.property as BabelNode).name === 'auth')
          if (isAttempt && onAuth && importsGuren) emit('passwordAuth', 'auth.attempt', lineOf(node))
        } else if (callee?.type === 'Import') {
          const first = (node.arguments as BabelNode[])[0]
          if (first?.type === 'StringLiteral' && LAMBDA_IMPORT_SOURCES.has(first.value as string)) {
            emit('lambda', first.value as string, lineOf(node))
          }
        }
        return
      }

      case 'ObjectProperty': {
        // autoSession/sessionOptions count wherever they appear, but only in a
        // file importing from Guren: neither key is distinctive on its own.
        // `autoSession: false` is the exception — it *suppresses* the warning,
        // so it is read gate or no gate, since missing an opt-out warns a
        // correctly-configured app.
        const keyName = propertyKeyName(node)
        if (keyName === 'autoSession') {
          if (importsGuren) emit('session', 'autoSession', lineOf(node))
          const value = node.value as BabelNode
          if (value?.type === 'BooleanLiteral' && value.value === false) {
            emit('sessionDisabled', 'autoSession: false', lineOf(node))
          }
        } else if (keyName === 'sessionOptions' && importsGuren) {
          emit('session', 'sessionOptions', lineOf(node))
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
 * Source files sitting directly in the project root, where deploy entrypoints
 * conventionally live. Its own non-recursive pass because pointing collectFiles
 * at the root would walk the whole tree.
 */
async function readRootSourceFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.endsWith('.d.ts'))
      .filter((entry) => IMPORTABLE_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => join(cwd, entry.name))
  } catch {
    // An unreadable project root leaves the directory scans as the only input.
    return []
  }
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
async function detectDeployTargets(cwd: string, files: ScannedFile[]): Promise<DeployTargetDetection[]> {
  const detections: DeployTargetDetection[] = []

  const declared = new Set(await readDeclaredDependencyNames(cwd))
  for (const [packageName, targetId] of Object.entries(DEPLOY_PLUGIN_PACKAGES)) {
    if (declared.has(packageName)) {
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
 * Scan the app once for everything the deploy-runtime doctor checks need:
 * declared deploy targets, and Bun-only defaults still in force.
 */
export async function analyzeDeployRuntime(cwd: string): Promise<DeployRuntimeAnalysis> {
  const { files, unparsed } = await readAppSources(cwd)
  const targets = await detectDeployTargets(cwd, files)

  const collect = (kind: SignalKind): SourceSignal[] =>
    files.flatMap((file) =>
      file.signals
        .filter((signal) => signal.kind === kind)
        .map((signal) => ({ symbol: signal.symbol, filePath: file.filePath, line: signal.line })),
    )

  return {
    targets,
    passwordAuthSignals: collect('passwordAuth'),
    bunOnlyHasherSignals: collect('bunOnlyHasher'),
    nodeHasherSignals: collect('nodeHasher'),
    sessionSignals: collect('session'),
    sessionDisabledSignals: collect('sessionDisabled'),
    oauthSignals: collect('oauth'),
    backedSessionSignals: collect('backedSession'),
    backedOAuthSignals: collect('backedOAuth'),
    memoryStoreSignals: collect('memoryStore'),
    memorySessionDefaultSignals: collect('memorySessionDefault'),
    discoverySignals: collect('discovery'),
    unparsedFiles: unparsed,
  }
}

/** Caveat appended to a check message when the scan was incomplete. */
export function formatParseCaveat(analysis: DeployRuntimeAnalysis): string {
  const { unparsedFiles } = analysis
  if (unparsedFiles.length === 0) return ''

  const shown = formatTruncatedList(unparsedFiles)
  return ` Note: ${unparsedFiles.length} file(s) could not be read or parsed and were not scanned: ${shown}.`
}

/** Targets that lack `Bun.password`, so an explicit `ScryptHasher` breaks. */
export function bunlessTargets(analysis: DeployRuntimeAnalysis): DeployTargetDetection[] {
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

/**
 * One deploy-runtime verdict, shaped for every consumer: `guren doctor` maps it
 * onto a DoctorCheck, `guren check` onto an advisory CheckResult, and the
 * deploy builds print it (RFC 0020 Part 0). A passing verdict carries no `fix`.
 */
export interface DeployRuntimeVerdict {
  key: 'deploy-password-hashing' | 'deploy-runtime-stores' | 'deploy-provider-discovery'
  title: string
  status: DeployRuntimeVerdictStatus
  message: string
  fix?: string
}

function verdict(
  key: DeployRuntimeVerdict['key'],
  title: string,
  status: DeployRuntimeVerdictStatus,
  message: string,
  fix?: string,
): DeployRuntimeVerdict {
  return status === 'pass' ? { key, title, status, message } : { key, title, status, message, fix }
}

const BUN_ONLY_HASHER_FIX = 'Replace `new ScryptHasher()` with `new Hash()`, which hashes with `node:crypto` scrypt off Bun. Rows already written under Bun stay unreadable on this runtime, so existing passwords must still be rehashed.'

/**
 * `DefaultHasher` falls back to `node:crypto` scrypt off Bun, which workerd's
 * `nodejs_compat` implements in full (RFC 0003 §4), so password auth alone no
 * longer breaks on a Bun-less target. What breaks is an *explicit*
 * `new ScryptHasher()`, whose Argon2id/bcrypt cannot be read back without
 * `Bun.password` — usually written by a seeder that ran under Bun locally.
 */
function judgePasswordHashing(analysis: DeployRuntimeAnalysis): DeployRuntimeVerdict {
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
    )
  }

  const labels = formatTargetLabels(bunless)

  if (analysis.bunOnlyHasherSignals.length > 0) {
    return verdict(
      key,
      title,
      'warn',
      `${labels} detected, but ScryptHasher is constructed directly (${formatSignals(analysis.bunOnlyHasherSignals)}). It hashes through Bun.password, so the rows it writes cannot be verified on this runtime.${caveat}`,
      BUN_ONLY_HASHER_FIX,
    )
  }

  if (analysis.passwordAuthSignals.length === 0) {
    return verdict(key, title, 'pass', `${labels} detected, and no password authentication was found.${caveat}`)
  }

  return verdict(
    key,
    title,
    'pass',
    `${labels} detected with password authentication (${formatSignals(analysis.passwordAuthSignals)}), and no Bun-only hasher is constructed. The default hasher uses node:crypto scrypt here.${caveat}`,
  )
}

const BACKED_STORE_FIX = 'Run `bunx guren add session` for a database-backed session store, use DatabaseOAuthStateStore from `@guren/core` (or the Redis equivalent from `@guren/core/redis`) for OAuth state, and a Redis-backed cache/queue driver.'

/**
 * Serverless targets share no memory between invocations, so in-memory stores
 * drop every session, cache entry, queued job, and OAuth state in production
 * while working perfectly in local development.
 */
function judgeRuntimeStores(analysis: DeployRuntimeAnalysis): DeployRuntimeVerdict {
  const key = 'deploy-runtime-stores'
  const title = 'Deploy Runtime Stores'

  const caveat = formatParseCaveat(analysis)

  if (analysis.targets.length === 0) {
    return verdict(key, title, 'pass', `No deploy plugin or Lambda adapter detected.${caveat}`)
  }

  const labels = formatTargetLabels(analysis.targets)
  const issues: string[] = []

  if (analysis.memoryStoreSignals.length > 0) {
    issues.push(`in-memory stores are constructed explicitly (${formatSignals(analysis.memoryStoreSignals)})`)
  }

  if (analysis.memorySessionDefaultSignals.length > 0 && analysis.sessionDisabledSignals.length === 0) {
    issues.push(
      `the session config selects the per-process \`memory\` store (${formatSignals(analysis.memorySessionDefaultSignals)})`,
    )
  }

  if (
    analysis.sessionSignals.length > 0 &&
    analysis.backedSessionSignals.length === 0 &&
    analysis.memorySessionDefaultSignals.length === 0 &&
    analysis.sessionDisabledSignals.length === 0
  ) {
    issues.push(
      `sessions are enabled (${formatSignals(analysis.sessionSignals)}) with no persistent store: no SessionConfig selects one, and no DatabaseSessionStore or RedisSessionStore is constructed`,
    )
  }

  if (analysis.oauthSignals.length > 0 && analysis.backedOAuthSignals.length === 0) {
    issues.push(
      `OAuth is configured (${formatSignals(analysis.oauthSignals)}) with no DatabaseOAuthStateStore or RedisOAuthStateStore`,
    )
  }

  if (issues.length === 0) {
    return verdict(key, title, 'pass', `${labels} detected, and no in-memory store defaults were found.${caveat}`)
  }

  return verdict(
    key,
    title,
    'warn',
    `${labels} shares no memory between requests, but ${issues.join('; ')}.${caveat}`,
    BACKED_STORE_FIX,
  )
}

const EXPLICIT_PROVIDERS_FIX = 'List providers explicitly in `createApp({ providers: [...] })` instead of discovering them from the filesystem.'

/**
 * `AutoDiscovery` scans directories with `Bun.Glob` and imports what it finds.
 * Every deploy target breaks that, either by having no Bun runtime or by
 * shipping a bundle with no source tree to scan.
 */
function judgeProviderDiscovery(analysis: DeployRuntimeAnalysis): DeployRuntimeVerdict {
  const key = 'deploy-provider-discovery'
  const title = 'Deploy Provider Discovery'

  const caveat = formatParseCaveat(analysis)

  if (analysis.targets.length === 0) {
    return verdict(key, title, 'pass', `No deploy plugin or Lambda adapter detected.${caveat}`)
  }

  const labels = formatTargetLabels(analysis.targets)

  if (analysis.discoverySignals.length === 0) {
    return verdict(key, title, 'pass', `${labels} detected, and provider discovery is not used.${caveat}`)
  }

  const blockers = analysis.targets.map((target) => `${target.profile.label}: ${target.profile.discoveryBlocker}`)

  return verdict(
    key,
    title,
    'warn',
    `${labels} detected, but the app uses filesystem provider discovery (${formatSignals(analysis.discoverySignals)}). ${blockers.join(' ')}${caveat}`,
    EXPLICIT_PROVIDERS_FIX,
  )
}

/** The three deploy-runtime verdicts over one analysis, in report order. */
export function judgeDeployRuntime(analysis: DeployRuntimeAnalysis): DeployRuntimeVerdict[] {
  return [judgePasswordHashing(analysis), judgeRuntimeStores(analysis), judgeProviderDiscovery(analysis)]
}

/**
 * Scan and judge in one call: what a deploy build runs before the app build.
 * Empty when the app declares no deploy target, so a caller prints nothing
 * for an app this cannot apply to; every verdict is present otherwise, passing
 * ones included, since the build may want to say what it verified.
 */
export async function checkDeployRuntime(cwd: string): Promise<DeployRuntimeVerdict[]> {
  const analysis = await analyzeDeployRuntime(cwd)
  return analysis.targets.length === 0 ? [] : judgeDeployRuntime(analysis)
}
