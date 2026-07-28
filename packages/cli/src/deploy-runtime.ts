import { readFile, readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import {
  collectFiles,
  toPosixRelative,
  IMPORTABLE_EXTENSIONS,
  NON_SOURCE_DIR_NAMES,
} from './discovery'
import { readDeclaredDependencyNames } from './plugin-manifest'

/**
 * Deploy targets whose runtime invalidates one or more of Guren's Bun-first
 * defaults. The prose versions of these warnings live in
 * packages/plugin-cloudflare/README.md ("Things Workers changes") and
 * docs/{en,ja}/guides/serverless.md; the checks below are their mechanical
 * counterpart.
 */
type DeployTargetId = 'cloudflare' | 'vercel' | 'lambda'

export interface DeployTargetProfile {
  id: DeployTargetId
  label: string
  /**
   * Whether `Bun.password` — the backend behind the default `ScryptHasher` —
   * exists at runtime. Vercel functions are built by `@guren/plugin-vercel`
   * with `runtime: 'bun1.x'`, so Bun's password APIs are present there; only
   * Workers (workerd) and Lambda (Node.js) lose them.
   */
  hasBunRuntime: boolean
  /** Why filesystem-scanning provider discovery cannot work on this target. */
  discoveryBlocker: string
}

const DEPLOY_TARGET_PROFILES: Record<DeployTargetId, DeployTargetProfile> = {
  cloudflare: {
    id: 'cloudflare',
    label: 'Cloudflare Workers',
    hasBunRuntime: false,
    discoveryBlocker: 'Workers has no filesystem and no Bun runtime, so `Bun.Glob` scanning finds nothing.',
  },
  vercel: {
    id: 'vercel',
    label: 'Vercel',
    // The function is a `bun build` bundle; buildVercelOutput copies
    // .guren/ssr, db/migrations, docs and public into it, never `app/`.
    hasBunRuntime: true,
    discoveryBlocker: 'The Vercel function is a `bun build` bundle that ships no `app/` directory to scan.',
  },
  lambda: {
    id: 'lambda',
    label: 'AWS Lambda',
    hasBunRuntime: false,
    discoveryBlocker: 'Lambda runs Node.js, where `Bun.Glob` is unavailable.',
  },
}

/**
 * Deploy plugin package names, matched against the app's own package.json.
 *
 * Matched by name rather than driven off the `gurenPlugin` manifest for two
 * reasons: the manifest lives in `node_modules/<pkg>/package.json`, so reading
 * it would stop detection working before `bun install`, and the Lambda target
 * ships inside `@guren/core` with no plugin package for a manifest to live in.
 * A manifest field would therefore cover two of three targets and leave the
 * third here anyway — two sources of truth instead of one.
 */
const DEPLOY_PLUGIN_PACKAGES: Record<string, DeployTargetId> = {
  '@guren/plugin-cloudflare': 'cloudflare',
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
  /** Evidence that the app authenticates with passwords at all. */
  passwordAuthSignals: SourceSignal[]
  /** `NodeHasher` constructions — the remediation for a Bun-less runtime. */
  nodeHasherSignals: SourceSignal[]
  /** Evidence that sessions are enabled. */
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
}

/** Directories scanned for the symbols above. */
const DEPLOY_SCAN_DIRS = ['src', 'app', 'config', 'db', 'routes', 'modules', 'bin', 'functions', 'api'] as const

/** Test files are excluded from the scan — see readAppSources. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/

// --- AST signal extraction -------------------------------------------------
//
// Signals are read from a Babel AST (the same parser audit.ts and
// model-parser.ts already use), not from per-line regexes. That buys, in one
// mechanism, everything the regex generation of this file had to carve out
// case by case: aliased imports resolve to their canonical names, values
// split across lines match, and text inside comments, string literals, and
// TypeScript type positions can no longer trip a check. Files that fail to
// parse contribute no signals rather than failing the doctor run.

type SignalKind =
  | 'passwordAuth'
  | 'nodeHasher'
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
 * Classes whose construction is a signal. Construction — not a bare import —
 * is what counts throughout: a leftover import survives long after the app
 * stops using the thing it names, and must neither satisfy a remediation
 * (NodeHasher, the backed stores) nor raise a warning (AutoDiscovery).
 *
 * ScryptHasher counts as password authentication because constructing one is
 * only ever done to hash a password (seeders do this). AutoDiscovery maps to
 * `discovery`; `ApplicationOptions.discover` is deliberately not a signal —
 * it is declared but never read anywhere in @guren/server, so warning about
 * it would flag a config key that has no effect.
 */
const CONSTRUCTED_SIGNALS: Record<string, SignalKind> = {
  ScryptHasher: 'passwordAuth',
  NodeHasher: 'nodeHasher',
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
 * Identifiers whose mere reference (outside an import declaration) is a
 * signal — OAuthServiceProvider is listed in `createApp({ providers })`
 * rather than constructed or called.
 */
const REFERENCED_SIGNALS: Record<string, SignalKind> = {
  OAuthServiceProvider: 'oauth',
}

/**
 * The Lambda adapter ships inside `@guren/core`/`@guren/server` rather than a
 * plugin package, so it is detected from these import sources (plus bare
 * `createLambdaHandler` calls via CALLED_SIGNALS).
 */
const LAMBDA_IMPORT_SOURCES = new Set(['@guren/core/lambda', '@guren/server/lambda'])

interface BabelNode {
  type: string
  loc?: { start: { line: number } }
  [key: string]: unknown
}

/**
 * Minimal generic AST walker. Recurses into every node-shaped child unless
 * the visitor returns `false` for the current node.
 */
function walk(value: unknown, visit: (node: BabelNode) => boolean | void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (value === null || typeof value !== 'object') return
  const node = value as BabelNode
  if (typeof node.type !== 'string') return

  if (visit(node) === false) return

  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') {
      continue
    }
    walk(child, visit)
  }
}

function propertyKeyName(property: BabelNode): string | null {
  if (property.computed) return null
  const key = property.key as BabelNode | undefined
  if (key?.type === 'Identifier') return key.name as string
  if (key?.type === 'StringLiteral') return key.value as string
  return null
}

function lineOf(node: BabelNode): number {
  return node.loc?.start.line ?? 1
}

/**
 * Extract every deploy-runtime signal from one source file. Returns null when
 * the file does not parse — the caller skips it.
 */
function extractSignals(source: string, plugins: ParserPlugin[]): ExtractedSignal[] | null {
  let ast
  try {
    ast = parse(source, { sourceType: 'module', plugins, allowAwaitOutsideFunction: true })
  } catch {
    return null
  }

  // Named-import aliases (`import { NodeHasher as X }`) resolve to their
  // canonical exported names, so every table below matches aliased use too.
  const aliases = new Map<string, string>()
  for (const statement of ast.program.body) {
    if (statement.type !== 'ImportDeclaration') continue
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const imported = specifier.imported
        aliases.set(specifier.local.name, imported.type === 'Identifier' ? imported.name : imported.value)
      }
    }
  }
  const canonical = (name: string): string => aliases.get(name) ?? name

  const signals: ExtractedSignal[] = []
  const seen = new Set<string>()
  const emit = (kind: SignalKind, symbol: string, line: number): void => {
    const key = `${kind} ${symbol}`
    if (seen.has(key)) return
    seen.add(key)
    signals.push({ kind, symbol, line })
  }

  walk(ast.program, (node) => {
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
        const source = node.source as BabelNode | null
        if (source && LAMBDA_IMPORT_SOURCES.has(source.value as string)) {
          emit('lambda', source.value as string, lineOf(node))
        }
        return
      }

      case 'NewExpression': {
        const callee = node.callee as BabelNode
        if (callee?.type === 'Identifier') {
          const name = canonical(callee.name as string)
          const kind = CONSTRUCTED_SIGNALS[name]
          if (kind) emit(kind, name, lineOf(node))
        }
        return
      }

      case 'CallExpression': {
        const callee = node.callee as BabelNode
        if (callee?.type === 'Identifier') {
          const name = canonical(callee.name as string)
          const kind = CALLED_SIGNALS[name]
          if (kind) emit(kind, name, lineOf(node))

          // An `auth` key in createApp's options object enables sessions:
          // AuthServiceProvider attaches session middleware whenever
          // `options.auth` is present and autoSession isn't explicitly false.
          // `make:auth` itself tells users to add exactly `auth: {}`, so the
          // bare key with no session-specific fields is the most common
          // real-world shape. Scoping to createApp (rather than any `auth:`
          // object) keeps SMTP-style `auth: { user, pass }` mailer config
          // from reading as a session.
          if (name === 'createApp') {
            const first = (node.arguments as BabelNode[])[0]
            if (first?.type === 'ObjectExpression') {
              for (const property of first.properties as BabelNode[]) {
                if (property.type === 'ObjectProperty' && propertyKeyName(property) === 'auth') {
                  emit('session', 'auth', lineOf(property))
                }
              }
            }
          }
        } else if (callee?.type === 'MemberExpression') {
          // `auth.attempt(...)` / `this.auth.attempt(...)` is the entry point
          // app code calls to verify a password (`guard.attempt()` sits
          // underneath it but is never called directly outside the
          // framework's own tests). Known gap: a registration-only app that
          // creates password-hashing records without ever calling attempt()
          // passes undetected — `make:auth` always scaffolds login alongside
          // registration, so that shape doesn't occur in generated apps.
          const property = callee.property as BabelNode
          const object = callee.object as BabelNode
          const isAttempt = property?.type === 'Identifier' && property.name === 'attempt'
          const onAuth =
            (object?.type === 'Identifier' && object.name === 'auth') ||
            (object?.type === 'MemberExpression' &&
              (object.property as BabelNode)?.type === 'Identifier' &&
              (object.property as BabelNode).name === 'auth')
          if (isAttempt && onAuth) emit('passwordAuth', 'auth.attempt', lineOf(node))
        } else if (callee?.type === 'Import') {
          const first = (node.arguments as BabelNode[])[0]
          if (first?.type === 'StringLiteral' && LAMBDA_IMPORT_SOURCES.has(first.value as string)) {
            emit('lambda', first.value as string, lineOf(node))
          }
        }
        return
      }

      case 'ObjectProperty': {
        // autoSession/sessionOptions count wherever they appear — session
        // config objects are routinely built outside the createApp call and
        // passed in. `autoSession: false` additionally raises the disabled
        // signal, which suppresses the session warning at the analysis level:
        // the opt-out may live in a different object or file than the
        // `auth` key that raised the signal.
        const keyName = propertyKeyName(node)
        if (keyName === 'autoSession') {
          emit('session', 'autoSession', lineOf(node))
          const value = node.value as BabelNode
          if (value?.type === 'BooleanLiteral' && value.value === false) {
            emit('sessionDisabled', 'autoSession: false', lineOf(node))
          }
        } else if (keyName === 'sessionOptions') {
          emit('session', 'sessionOptions', lineOf(node))
        }
        return
      }

      case 'Identifier': {
        const name = canonical(node.name as string)
        const kind = REFERENCED_SIGNALS[name]
        if (kind) emit(kind, name, lineOf(node))
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

function parserPluginsFor(path: string): ParserPlugin[] {
  // JSX is off for .ts/.mts so angle-bracket type assertions still parse;
  // everywhere else it is harmless and lets .tsx/.jsx through.
  const ext = extname(path)
  return ext === '.ts' || ext === '.mts' ? ['typescript'] : ['typescript', 'jsx']
}

/**
 * Source files sitting directly in the project root. Deploy entrypoints
 * (`lambda.ts`, `worker.ts`) conventionally live there, and collectFiles only
 * recurses, so the root's own files need their own non-recursive pass.
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
 * Read and signal-scan the app's own source files from a bounded set of
 * roots: the directories in DEPLOY_SCAN_DIRS plus any source file in the
 * project root.
 *
 * Test files are excluded. A fixture that constructs a backed store or a
 * NodeHasher would otherwise satisfy the remediation check on behalf of an
 * application that never wires one up, hiding a real production gap — and a
 * fixture enabling sessions would report sessions the app itself never enables.
 */
async function readAppSources(cwd: string): Promise<ScannedFile[]> {
  const [directoryFiles, rootFiles] = await Promise.all([
    Promise.all(
      DEPLOY_SCAN_DIRS.map((dir) =>
        collectFiles(resolve(cwd, dir), IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES),
      ),
    ),
    readRootSourceFiles(cwd),
  ])

  const paths = [...rootFiles, ...directoryFiles.flat()].filter((path) => !TEST_FILE_PATTERN.test(path))

  const scanned = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path, 'utf8').catch(() => null)
      if (content === null) return null
      const signals = extractSignals(content, parserPluginsFor(path))
      if (signals === null) return null
      return { filePath: toPosixRelative(cwd, path), signals }
    }),
  )

  return scanned.filter((file): file is ScannedFile => file !== null)
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

  const lambdaFile = files.find((file) => file.signals.some((signal) => signal.kind === 'lambda'))
  if (lambdaFile) {
    detections.push({
      profile: DEPLOY_TARGET_PROFILES.lambda,
      detectedVia: `Lambda adapter imported in ${lambdaFile.filePath}`,
    })
  }

  return detections
}

/**
 * Scan the app once and collect everything the deploy-runtime doctor checks
 * need: which deploy targets are declared, and which Bun-only defaults are
 * still in force.
 */
export async function analyzeDeployRuntime(cwd: string): Promise<DeployRuntimeAnalysis> {
  const files = await readAppSources(cwd)
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
    nodeHasherSignals: collect('nodeHasher'),
    sessionSignals: collect('session'),
    sessionDisabledSignals: collect('sessionDisabled'),
    oauthSignals: collect('oauth'),
    backedSessionSignals: collect('backedSession'),
    backedOAuthSignals: collect('backedOAuth'),
    memoryStoreSignals: collect('memoryStore'),
    discoverySignals: collect('discovery'),
  }
}

/** Targets that lack `Bun.password`, so the default `ScryptHasher` breaks. */
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
