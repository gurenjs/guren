import { readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { File } from '@babel/types'
import { walk, lineOf, type BabelNode } from './ast-walk'
import {
  collectFiles,
  toPosixRelative,
  IMPORTABLE_EXTENSIONS,
  NON_SOURCE_DIR_NAMES,
} from './discovery'
import { ParseCache } from './parse-cache'
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
    label: 'Cloudflare Workers',
    hasBunRuntime: false,
    discoveryBlocker: 'Workers has no filesystem and no Bun runtime, so `Bun.Glob` scanning finds nothing.',
  },
  vercel: {
    label: 'Vercel',
    // The function is a `bun build` bundle; buildVercelOutput copies
    // .guren/ssr, db/migrations, docs and public into it, never `app/`.
    hasBunRuntime: true,
    discoveryBlocker: 'The Vercel function is a `bun build` bundle that ships no `app/` directory to scan.',
  },
  lambda: {
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
  /**
   * Files that could not be read or parsed and therefore contributed no
   * signals. Surfaced in every deploy check message so a missed hazard or
   * remediation is a visible caveat, not a silent false negative — the same
   * stance ESLint (parse errors are errors) and semgrep (skipped files are
   * counted) take. Note this also covers *target* detection: the Lambda
   * adapter is found in source, so a skipped file can hide a target too.
   */
  unparsedFiles: string[]
}

/** Directories scanned for signal symbols. */
const DEPLOY_SCAN_DIRS = ['src', 'app', 'config', 'db', 'routes', 'modules', 'bin', 'functions', 'api'] as const

/** Test files are excluded from the scan — see readAppSources. */
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/

// --- AST signal extraction -------------------------------------------------
//
// Signals are read from a Babel AST (the same parser audit.ts and
// model-parser.ts already use), not from per-line regexes. That buys, in one
// mechanism, everything the regex generation of this file had to carve out
// case by case: values split across lines match, and text inside comments,
// string literals, and TypeScript type positions cannot trip a check.
//
// Every signal name is resolved through the file's own `@guren/*` value
// imports rather than matched bare. A name only means the Guren API of that
// name when it was imported from Guren, so `import { NodeHasher } from
// './my-own'` no longer satisfies a remediation and an unrelated
// `DatabaseSessionStore` no longer hides a real gap. Aliases and namespace
// imports resolve to their canonical exported names, so `NodeHasher as X`
// and `g.NodeHasher` both count.
//
// Known limitations, both needing scope/dataflow analysis this deliberately
// stops short of: a local binding that shadows an imported signal name still
// counts, and an options object built elsewhere and passed into createApp
// (`const o = { auth: {} }; createApp(o)`) is not seen — though any
// `autoSession`/`sessionOptions` key inside it is, wherever it lives.

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

/** Only names imported from a Guren package resolve to a signal. */
const GUREN_PACKAGE_PREFIX = '@guren/'

/**
 * Type-only syntax. Skipped wholesale so an identifier in a type annotation,
 * generic constraint, type query, or interface body never reads as usage.
 * Nodes that merely *carry* a type while wrapping a real expression
 * (TSAsExpression, TSNonNullExpression, TSSatisfiesExpression) are absent
 * here on purpose — their expression still has to be walked.
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
 * plugin package, so it is detected from these import sources (plus bare
 * `createLambdaHandler` calls via CALLED_SIGNALS).
 */
const LAMBDA_IMPORT_SOURCES = new Set(['@guren/core/lambda', '@guren/server/lambda'])

function propertyKeyName(property: BabelNode): string | null {
  if (property.computed) return null
  const key = property.key as BabelNode | undefined
  if (key?.type === 'Identifier') return key.name as string
  if (key?.type === 'StringLiteral') return key.value as string
  return null
}

/** Extract every deploy-runtime signal from one parsed source file. */
function extractSignals(ast: File): ExtractedSignal[] {
  // Value imports from `@guren/*`, mapping the file's local name to the
  // canonical exported name. Type-only imports are excluded — they cannot be
  // constructed or called — and so is every non-Guren source, so a same-named
  // export from another package never resolves to a signal.
  const gurenNames = new Map<string, string>()
  const gurenNamespaces = new Set<string>()
  // Whether the file imports from Guren at all, type-only imports included.
  // The two signals resolved structurally rather than through a binding —
  // `auth.attempt()` (a controller property) and the session option keys —
  // use this to stay inside Guren code: without it any library's
  // `auth.attempt()` or `sessionOptions` key raised a Guren signal.
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
   * Canonical Guren export name for a callee/identifier, or null when it does
   * not resolve to one. Covers plain and aliased named imports plus
   * `ns.Member` access through a namespace import.
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
    const key = `${kind} ${symbol}`
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
        }

        if (callee?.type === 'MemberExpression') {
          // `auth.attempt(...)` / `this.auth.attempt(...)` is the entry point
          // app code calls to verify a password (`guard.attempt()` sits
          // underneath it but is never called directly outside the
          // framework's own tests). Resolved structurally rather than through
          // the import map: `auth` here is a controller property, not an
          // import. Known gap: a registration-only app that creates
          // password-hashing records without ever calling attempt() passes
          // undetected — `make:auth` always scaffolds login alongside
          // registration, so that shape doesn't occur in generated apps.
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
        // autoSession/sessionOptions count wherever they appear — session
        // config objects are routinely built outside the createApp call and
        // passed in — but only inside a file that imports from Guren, since
        // neither key is distinctive enough to claim on its own.
        //
        // `autoSession: false` is the deliberate exception: it *suppresses*
        // the warning, so it is read everywhere, gate or no gate. Missing an
        // opt-out warns a correctly-configured app, which is the failure
        // direction this check exists to avoid; missing an opt-in only costs
        // a warning the `auth` key already raises in the common shape.
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
 * Source files sitting directly in the project root. Deploy entrypoints
 * (`lambda.ts`, `worker.ts`) conventionally live there, and no DEPLOY_SCAN_DIRS
 * entry covers the root itself — pointing collectFiles at it would walk the
 * whole tree, so the root gets its own non-recursive pass.
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

  const cache = new ParseCache()
  const scanned = await Promise.all(
    paths.map(async (path) => ({
      filePath: toPosixRelative(cwd, path),
      outcome: await cache.read(path),
    })),
  )

  const files: ScannedFile[] = []
  const unparsed: string[] = []
  for (const { filePath, outcome } of scanned) {
    // An unreadable file is reported alongside an unparseable one: both
    // contribute no signals, and silently dropping either is the hole the
    // caveat exists to close.
    if (outcome.status !== 'parsed') unparsed.push(filePath)
    else files.push({ filePath, signals: extractSignals(outcome.ast) })
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
    nodeHasherSignals: collect('nodeHasher'),
    sessionSignals: collect('session'),
    sessionDisabledSignals: collect('sessionDisabled'),
    oauthSignals: collect('oauth'),
    backedSessionSignals: collect('backedSession'),
    backedOAuthSignals: collect('backedOAuth'),
    memoryStoreSignals: collect('memoryStore'),
    discoverySignals: collect('discovery'),
    unparsedFiles: unparsed,
  }
}

/**
 * Caveat appended to signal-dependent check messages when files were skipped:
 * a verdict computed over an incomplete scan should say so.
 */
export function formatParseCaveat(analysis: DeployRuntimeAnalysis): string {
  const { unparsedFiles } = analysis
  if (unparsedFiles.length === 0) return ''

  const shown = unparsedFiles.slice(0, 3).join(', ')
  const more = unparsedFiles.length > 3 ? ` and ${unparsedFiles.length - 3} more` : ''
  return ` Note: ${unparsedFiles.length} file(s) could not be read or parsed and were not scanned: ${shown}${more}.`
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
