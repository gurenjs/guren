import { readFile, readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
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
export type DeployTargetId = 'cloudflare' | 'vercel' | 'lambda'

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

/** Deploy plugin package names, matched against the app's own package.json. */
const DEPLOY_PLUGIN_PACKAGES: Record<string, DeployTargetId> = {
  '@guren/plugin-cloudflare': 'cloudflare',
  '@guren/plugin-vercel': 'vercel',
}

/**
 * The Lambda adapter ships inside `@guren/core`/`@guren/server` rather than a
 * plugin package, so it is detected from source imports instead.
 */
const LAMBDA_SOURCE_PATTERN = /@guren\/(?:core|server)\/lambda|\bcreateLambdaHandler\b/

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
  /** Targets that lack `Bun.password`, so the default `ScryptHasher` breaks. */
  bunlessTargets: DeployTargetDetection[]
  /** Evidence that the app authenticates with passwords at all. */
  passwordAuthSignals: SourceSignal[]
  /** `NodeHasher` references — the remediation for a Bun-less runtime. */
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

type SymbolPatterns = ReadonlyArray<readonly [symbol: string, pattern: RegExp]>

/**
 * Signals that the password hasher is actually reached: `auth.attempt()` is
 * the entry point app code calls to verify a password (`guard.attempt()` sits
 * underneath it but is never called directly outside the framework's own
 * tests), and an explicitly constructed `ScryptHasher` hashes one (seeders do
 * this).
 *
 * Deliberately excludes `AuthenticatableModel`, `passwordColumn`, and a
 * `passwordHash` column. OAuth-only apps keep all three — the guard needs
 * `passwordColumn` to reject password logins for hash-less accounts — while
 * never invoking a hasher, so matching them reports a break that cannot happen.
 *
 * Known gap: a registration-only app that creates password-hashing records
 * (`User.create({ password })`) without ever calling `auth.attempt()` would
 * pass undetected. `make:auth` always scaffolds login alongside registration,
 * so this shape doesn't occur in generated apps; a hand-rolled register-only
 * flow is the one case this misses.
 */
const PASSWORD_AUTH_PATTERNS: SymbolPatterns = [
  ['auth.attempt', /\bauth\s*\.\s*attempt\s*\(/],
  ['ScryptHasher', /\bnew\s+ScryptHasher\s*\(/],
]

/**
 * Only a constructed hasher counts — a bare import survives long after the
 * app stops using it. Known gap: `import { NodeHasher as X }; new X()` isn't
 * recognized, since matching an aliased import would need to correlate two
 * separate lines rather than test each line independently. Line-scanning for
 * a literal name is the established pattern throughout this file.
 */
const NODE_HASHER_PATTERNS: SymbolPatterns = [['NodeHasher', /\bnew\s+NodeHasher\s*\(/]]

/**
 * `AuthServiceProvider` attaches session middleware whenever `options.auth`
 * is present at all and `autoSession` isn't explicitly `false` — `make:auth`
 * itself instructs users to add exactly `auth: {}` to enable sessions and
 * CSRF, so a bare `auth: {}` is the single most common real-world shape and
 * must be caught, not just an explicit `autoSession`/`sessionOptions` key.
 * Requiring the `{` after `auth:` keeps this from matching the unrelated
 * `'auth:user_id'`-style session-key string literals used elsewhere.
 *
 * The explicit opt-out (`autoSession: false`) is intentionally NOT excluded
 * here: `auth: {` alone can't see what the object it opens contains, and
 * `autoSession: false` may sit on a different line or in a different file
 * from the `auth: {` that matched. It is tracked separately in
 * SESSION_DISABLED_PATTERNS and suppresses the warning at the analysis level
 * instead, where it can be checked app-wide rather than line-by-line.
 */
const SESSION_PATTERNS: SymbolPatterns = [
  ['auth', /\bauth\s*:\s*\{/],
  ['autoSession', /\bautoSession\b/],
  ['sessionOptions', /\bsessionOptions\b/],
  ['createSessionMiddleware', /\bcreateSessionMiddleware\b/],
]

/**
 * Known gap: `autoSession:` and `false` split across two lines (e.g. a
 * multi-line-formatted value) won't match, since each pattern is tested
 * against one line at a time. Prettier never breaks a boolean property value
 * onto its own line, so this doesn't occur in formatted code.
 */
const SESSION_DISABLED_PATTERNS: SymbolPatterns = [
  ['autoSession: false', /\bautoSession\s*:\s*false\b/],
]

const OAUTH_PATTERNS: SymbolPatterns = [
  ['createOAuthManager', /\bcreateOAuthManager\b/],
  ['OAuthServiceProvider', /\bOAuthServiceProvider\b/],
]

/**
 * Backed stores count as remediation only where they are constructed, not
 * merely imported — a leftover import would otherwise silence the warning for
 * an app that no longer wires the store up. Stores built in one module and
 * passed in from another still match, because the whole app tree is scanned.
 */
const BACKED_SESSION_PATTERNS: SymbolPatterns = [
  ['DatabaseSessionStore', /\bnew\s+DatabaseSessionStore\s*\(/],
  ['RedisSessionStore', /\bnew\s+RedisSessionStore\s*\(/],
]

const BACKED_OAUTH_PATTERNS: SymbolPatterns = [
  ['DatabaseOAuthStateStore', /\bnew\s+DatabaseOAuthStateStore\s*\(/],
  ['RedisOAuthStateStore', /\bnew\s+RedisOAuthStateStore\s*\(/],
]

/**
 * In-memory stores instantiated explicitly. Unlike the implicit defaults these
 * need no gating signal — constructing one is unambiguous.
 */
const MEMORY_STORE_PATTERNS: SymbolPatterns = [
  ['MemorySessionStore', /\bnew\s+MemorySessionStore\s*\(/],
  ['MemoryOAuthStateStore', /\bnew\s+MemoryOAuthStateStore\s*\(/],
  ['MemoryApiTokenStore', /\bnew\s+MemoryApiTokenStore\s*\(/],
  ['MemoryPasswordResetStore', /\bnew\s+MemoryPasswordResetStore\s*\(/],
  ['MemoryEmailVerificationStore', /\bnew\s+MemoryEmailVerificationStore\s*\(/],
  ['MemoryRateLimitStore', /\bnew\s+MemoryRateLimitStore\s*\(/],
  ['MemoryStore', /\bnew\s+MemoryStore\s*\(/],
  ['MemoryDriver', /\bnew\s+MemoryDriver\s*\(/],
]

/**
 * Only a constructed AutoDiscovery counts — a bare import isn't active use.
 * `ApplicationOptions.discover` is deliberately not matched here: it is
 * declared but never read anywhere in @guren/server, so it has no effect —
 * warning about it would flag a config key that doesn't actually do anything.
 *
 * Known gap: `import { AutoDiscovery as X }; new X()` isn't recognized, the
 * same aliased-import limitation as NODE_HASHER_PATTERNS above.
 */
const DISCOVERY_PATTERNS: SymbolPatterns = [
  ['AutoDiscovery', /\bnew\s+AutoDiscovery\s*\(/],
]

interface ScannedFile {
  filePath: string
  content: string
  /** Split once per file and reused across every pattern pass in findSignals. */
  lines: string[]
}

/**
 * Read the app's own source files from a bounded set of roots: the directories
 * in DEPLOY_SCAN_DIRS plus any source file sitting directly in the project root
 * (deploy entrypoints like `lambda.ts` or `worker.ts` conventionally live there).
 */
async function readAppSources(cwd: string): Promise<ScannedFile[]> {
  const directoryFiles = await Promise.all(
    DEPLOY_SCAN_DIRS.map((dir) =>
      collectFiles(resolve(cwd, dir), IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES),
    ),
  )

  const rootFiles: string[] = []
  try {
    for (const entry of await readdir(cwd, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      if (entry.name.endsWith('.d.ts')) continue
      if (IMPORTABLE_EXTENSIONS.has(extname(entry.name))) {
        rootFiles.push(join(cwd, entry.name))
      }
    }
  } catch {
    // An unreadable project root leaves the directory scans as the only input.
  }

  const paths = [...rootFiles, ...directoryFiles.flat()]

  const scanned = await Promise.all(
    paths.map(async (path) => {
      const content = await readFile(path, 'utf8').catch(() => null)
      if (content === null) return null
      return { filePath: toPosixRelative(cwd, path), content, lines: content.split('\n') }
    }),
  )

  return scanned.filter((file): file is ScannedFile => file !== null)
}

function findSignals(files: ScannedFile[], patterns: SymbolPatterns): SourceSignal[] {
  const signals: SourceSignal[] = []

  for (const file of files) {
    for (const [symbol, pattern] of patterns) {
      const index = file.lines.findIndex((line) => pattern.test(line))
      if (index !== -1) {
        signals.push({ symbol, filePath: file.filePath, line: index + 1 })
      }
    }
  }

  return signals
}

/**
 * Deploy targets declared by the app: plugin packages from its package.json
 * dependencies, plus the Lambda adapter detected from source imports.
 */
export async function detectDeployTargets(cwd: string): Promise<DeployTargetDetection[]> {
  return detectTargetsIn(cwd, await readAppSources(cwd))
}

async function detectTargetsIn(cwd: string, files: ScannedFile[]): Promise<DeployTargetDetection[]> {
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

  const lambdaFile = files.find((file) => LAMBDA_SOURCE_PATTERN.test(file.content))
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
  const targets = await detectTargetsIn(cwd, files)

  return {
    targets,
    bunlessTargets: targets.filter((target) => !target.profile.hasBunRuntime),
    passwordAuthSignals: findSignals(files, PASSWORD_AUTH_PATTERNS),
    nodeHasherSignals: findSignals(files, NODE_HASHER_PATTERNS),
    sessionSignals: findSignals(files, SESSION_PATTERNS),
    sessionDisabledSignals: findSignals(files, SESSION_DISABLED_PATTERNS),
    oauthSignals: findSignals(files, OAUTH_PATTERNS),
    backedSessionSignals: findSignals(files, BACKED_SESSION_PATTERNS),
    backedOAuthSignals: findSignals(files, BACKED_OAUTH_PATTERNS),
    memoryStoreSignals: findSignals(files, MEMORY_STORE_PATTERNS),
    discoverySignals: findSignals(files, DISCOVERY_PATTERNS),
  }
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
