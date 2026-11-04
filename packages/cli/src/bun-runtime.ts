/**
 * The Bun runtime check (RFC 0039 §6): each version the app runs on (the process,
 * `engines.bun`, `packageManager`, the `oven/bun` images of its Dockerfiles) against
 * `oven-sh/bun`'s repository advisories, which `bun audit` and OSV do not carry. A
 * read that fails is `unavailable`, and a value naming no one release is not matched.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GraphCoverage } from './application-graph'
import type { AuditFinding } from './audit'

export type RuntimeSource = 'process' | 'engines' | 'packageManager' | 'dockerfile'

export interface RuntimeVersion {
  source: RuntimeSource
  /** As written: a version, a range, or a whole image reference. */
  value: string
  /** `value` names one release, so it is matched. */
  exact: boolean
  /** The release `value` names, without build metadata. */
  version?: string
  file?: string
  line?: number
  /** An image reference's digest. */
  digest?: string
  /** The GHSA of every advisory whose range holds `version`. */
  advisories?: string[]
}

export interface BunAdvisory {
  ghsa: string
  severity: string
  summary: string
  url: string
  vulnerabilities: Array<{ range: string; patched: string | null }>
}

export type AdvisoryRead = { ok: true; advisories: BunAdvisory[] } | { ok: false; reason: string }

export interface RuntimeMatch {
  advisory: BunAdvisory
  versions: RuntimeVersion[]
}

export interface RuntimeCheck {
  coverage: GraphCoverage
  versions: RuntimeVersion[]
  matches: RuntimeMatch[]
}

export type HttpFetch = (url: string, init?: RequestInit) => Promise<Response>

const ADVISORIES_URL = 'https://api.github.com/repos/oven-sh/bun/security-advisories?per_page=100'
const GITHUB_API_HOST = 'api.github.com'
const MAX_PAGES = 10
const REQUEST_TIMEOUT_MS = 10_000
const RELEASE = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+[0-9A-Za-z.-]+)?$/u
const IMAGE = /^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\/)?oven\/bun(?::([^@\s]+))?(?:@(sha256:[0-9a-f]{64}))?$/u
const DOCKERFILE = /^(?:dockerfile|containerfile)(?:\..+)?$|\.dockerfile$/iu
const COMPARATOR = /\s*(>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*/uy

function release(value: string): string | null {
  return RELEASE.exec(value.trim())?.[1] ?? null
}

/**
 * Whether `version` is inside one of GitHub's ranges (`>= 1.0.21, < 1.4.4`), by full
 * semver precedence, so a canary of a patched release is outside and one before it
 * inside; `null` for a range this grammar does not read, which the caller counts.
 */
export function inAdvisoryRange(version: string, range: string): boolean | null {
  const alternatives = range.split('||').map((part) => part.replaceAll(',', ' ').trim())
  let holds = false
  for (const alternative of alternatives) {
    if (alternative === '') return null
    let satisfied = true
    COMPARATOR.lastIndex = 0
    while (COMPARATOR.lastIndex < alternative.length) {
      const match = COMPARATOR.exec(alternative)
      if (!match) return null
      const order = Bun.semver.order(version, match[2]!)
      const op = match[1] ?? '='
      if (!(op === '>=' ? order >= 0 : op === '<=' ? order <= 0 : op === '>' ? order > 0 : op === '<' ? order < 0 : order === 0)) satisfied = false
    }
    if (satisfied) holds = true
  }
  return holds
}

function versionEntry(source: RuntimeSource, value: string, extra: Partial<RuntimeVersion> = {}): RuntimeVersion {
  const version = release(value)
  return { source, value, exact: version !== null, ...(version ? { version } : {}), ...extra }
}

/** `FROM` lines naming `oven/bun`, with the `ARG` defaults declared before the first `FROM` substituted. */
export function readDockerfileImages(text: string, file: string): RuntimeVersion[] {
  const args = new Map<string, string>()
  const images: RuntimeVersion[] = []
  let sawFrom = false
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim()
    const instruction = /^(\w+)\s+(.*)$/u.exec(line)
    if (!instruction) continue
    const keyword = instruction[1]!.toUpperCase()
    if (keyword === 'ARG' && !sawFrom) {
      const arg = /^([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|(\S*))$/u.exec(instruction[2]!.trim())
      if (arg) args.set(arg[1]!, arg[2] ?? arg[3] ?? arg[4] ?? '')
      continue
    }
    if (keyword !== 'FROM') continue
    sawFrom = true
    const reference = instruction[2]!.split(/\s+/u).find((token) => !token.startsWith('--'))
    if (!reference) continue
    const value = reference.replace(/\$\{(\w+)\}|\$(\w+)/gu, (whole, braced?: string, bare?: string) => args.get(braced ?? bare ?? '') ?? whole)
    const image = IMAGE.exec(value)
    if (!image) continue
    const tag = image[1] ?? 'latest'
    const version = /^\d+\.\d+\.\d+$/u.test(tag.split('-')[0]!) ? tag.split('-')[0]! : null
    images.push({
      source: 'dockerfile',
      value: reference === value ? value : `${reference} (${value})`,
      exact: version !== null,
      ...(version ? { version } : {}),
      file,
      line: index + 1,
      ...(image[2] ? { digest: image[2] } : {}),
    })
  }
  return images
}

/** Every version the app at `cwd` names; `processVersion` is `process.versions.bun`, absent under Node. */
export async function readRuntimeVersions(cwd: string, processVersion: string | undefined): Promise<RuntimeVersion[]> {
  const versions: RuntimeVersion[] = []
  if (processVersion) versions.push(versionEntry('process', processVersion))
  const manifest = await readFile(join(cwd, 'package.json'), 'utf8').then((text) => JSON.parse(text) as unknown, () => null)
  if (typeof manifest === 'object' && manifest !== null) {
    const { engines, packageManager } = manifest as { engines?: { bun?: unknown }; packageManager?: unknown }
    if (typeof engines?.bun === 'string') versions.push(versionEntry('engines', engines.bun))
    if (typeof packageManager === 'string' && packageManager.startsWith('bun@')) {
      versions.push(versionEntry('packageManager', packageManager.slice('bun@'.length), { value: packageManager }))
    }
  }
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.filter((candidate) => candidate.isFile() && DOCKERFILE.test(candidate.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const text = await readFile(join(cwd, entry.name), 'utf8').catch(() => null)
    if (text !== null) versions.push(...readDockerfileImages(text, entry.name))
  }
  return versions
}

function nextPage(link: string | null): string | null {
  return link?.split(',').map((part) => /<([^>]+)>;\s*rel="next"/u.exec(part)?.[1]).find(Boolean) ?? null
}

function parseAdvisories(body: unknown): BunAdvisory[] | null {
  if (!Array.isArray(body)) return null
  const advisories: BunAdvisory[] = []
  for (const item of body as Array<Record<string, unknown>>) {
    if (typeof item?.ghsa_id !== 'string' || !Array.isArray(item.vulnerabilities)) return null
    if (item.state !== 'published' || item.withdrawn_at) continue
    const vulnerabilities = (item.vulnerabilities as Array<Record<string, unknown>>).flatMap((entry) => {
      const pkg = entry?.package as { ecosystem?: unknown; name?: unknown } | undefined
      if (pkg?.ecosystem !== 'npm' || pkg.name !== 'bun' || typeof entry.vulnerable_version_range !== 'string') return []
      return [{ range: entry.vulnerable_version_range, patched: typeof entry.patched_versions === 'string' && entry.patched_versions !== '' ? entry.patched_versions : null }]
    })
    if (vulnerabilities.length === 0) continue
    advisories.push({
      ghsa: item.ghsa_id,
      severity: typeof item.severity === 'string' ? item.severity.toLowerCase() : 'unknown',
      summary: typeof item.summary === 'string' ? item.summary : item.ghsa_id,
      url: typeof item.html_url === 'string' ? item.html_url : `https://github.com/oven-sh/bun/security/advisories/${item.ghsa_id}`,
      vulnerabilities,
    })
  }
  return advisories
}

/** `oven-sh/bun`'s published advisories, every page; the token goes to `api.github.com` only. */
export async function fetchBunAdvisories(options: { fetch?: HttpFetch; token?: string } = {}): Promise<AdvisoryRead> {
  const fetchImpl = options.fetch ?? fetch
  const token = options.token ?? (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined)
  const advisories: BunAdvisory[] = []
  let url: string | null = ADVISORIES_URL
  for (let page = 0; url !== null; page += 1) {
    if (page === MAX_PAGES) return { ok: false, reason: `the advisories ran past ${MAX_PAGES} pages` }
    const sendToken = token !== undefined && new URL(url).host === GITHUB_API_HOST
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(sendToken ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      return { ok: false, reason: `api.github.com did not answer: ${error instanceof Error ? error.message : String(error)}` }
    }
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      return { ok: false, reason: sendToken ? 'GitHub\'s rate limit for this token is used up' : 'GitHub\'s rate limit for unauthenticated requests (60 an hour) is used up; set GITHUB_TOKEN' }
    }
    if (!response.ok) return { ok: false, reason: `api.github.com answered ${response.status}` }
    const parsed = parseAdvisories(await response.json().catch(() => null))
    if (parsed === null) return { ok: false, reason: 'api.github.com returned an unrecognised advisory list' }
    advisories.push(...parsed)
    url = nextPage(response.headers.get('link'))
  }
  return { ok: true, advisories }
}

export function describeRuntimeVersion(version: RuntimeVersion): string {
  if (version.source === 'process') return `the running Bun ${version.value}`
  if (version.source === 'engines') return `engines.bun ${version.value}`
  if (version.source === 'packageManager') return `packageManager ${version.value}`
  return `${version.file}:${version.line} ${version.value}`
}

export function judgeRuntime(versions: readonly RuntimeVersion[], read: AdvisoryRead): RuntimeCheck {
  const reasons: GraphCoverage['reasons'] = versions.filter((version) => !version.exact).map((version) => ({
    code: 'inexact-version',
    message: `${describeRuntimeVersion(version)} names no single Bun release, so it is not matched.`,
    ...(version.file ? { file: version.file } : {}),
  }))
  if (!versions.some((version) => version.exact)) reasons.push({ code: 'no-version', message: 'No exact Bun version was found to check.' })
  if (!read.ok) {
    return {
      coverage: { status: 'unavailable', reasons: [{ code: 'advisories-unavailable', message: `oven-sh/bun's advisories could not be read (${read.reason}).` }, ...reasons] },
      versions: [...versions],
      matches: [],
    }
  }
  const annotated = versions.map((version) => ({ ...version }))
  const matches: RuntimeMatch[] = []
  for (const advisory of read.advisories) {
    const inside = annotated.filter((version) => version.version !== undefined && advisory.vulnerabilities.some(({ range }) => {
      const holds = inAdvisoryRange(version.version!, range)
      if (holds === null && !reasons.some((reason) => reason.code === 'unreadable-range' && reason.message.includes(advisory.ghsa))) {
        reasons.push({ code: 'unreadable-range', message: `${advisory.ghsa}'s range "${range}" could not be read, so every version is treated as inside it.` })
      }
      return holds !== false
    }))
    if (inside.length === 0) continue
    for (const version of inside) version.advisories = [...(version.advisories ?? []), advisory.ghsa]
    matches.push({ advisory, versions: inside })
  }
  return { coverage: { status: reasons.length === 0 ? 'complete' : 'partial', reasons }, versions: annotated, matches }
}

export async function checkRuntime(cwd: string, options: { fetch?: HttpFetch; token?: string; processVersion?: string | null } = {}): Promise<RuntimeCheck> {
  const processVersion = options.processVersion === null ? undefined : options.processVersion ?? process.versions.bun
  const [versions, read] = await Promise.all([
    readRuntimeVersions(cwd, processVersion),
    fetchBunAdvisories(options).catch((error: unknown): AdvisoryRead => ({ ok: false, reason: error instanceof Error ? error.message : String(error) })),
  ])
  return judgeRuntime(versions, read)
}

/** The audit findings of a check: one per matched advisory, one per Dockerfile image short of `oven/bun:<version>@sha256:…`. */
export function runtimeFindings(check: RuntimeCheck): AuditFinding[] {
  const findings: AuditFinding[] = []
  if (check.coverage.status === 'unavailable') {
    findings.push({
      key: 'deps:runtime-scan',
      title: 'Bun runtime',
      status: 'warn',
      message: `The Bun runtime could not be checked: ${check.coverage.reasons[0]?.message ?? 'no reason was given.'}`,
      suggestion: 'Re-run with access to api.github.com (in CI, pass GITHUB_TOKEN), or pass --no-deps to skip the dependency checks on purpose.',
    })
  }
  for (const { advisory, versions } of check.matches) {
    const patched = [...new Set(advisory.vulnerabilities.flatMap(({ patched }) => (patched ? [patched] : [])))]
    const images = versions.some((version) => version.source === 'dockerfile')
    findings.push({
      key: `deps:runtime:${advisory.ghsa}`,
      title: 'Bun runtime',
      status: advisory.severity === 'critical' || advisory.severity === 'high' ? 'fail' : 'warn',
      message: `${advisory.severity} advisory (${advisory.vulnerabilities.map(({ range }) => range).join(' || ')}): ${advisory.summary.replace(/\.$/u, '')}. Inside it: ${versions.map(describeRuntimeVersion).join(', ')}.`,
      suggestion: `${patched.length > 0 ? `Move to Bun ${patched.join(' or ')}` : 'No patched Bun is named yet; follow'} (see ${advisory.url})${images ? ', then run guren deploy again so the Dockerfile names it' : ''}.`,
      runtime: { ghsa: advisory.ghsa, ranges: advisory.vulnerabilities.map(({ range }) => range), patched, versions },
    })
  }
  for (const image of check.versions.filter((version) => version.source === 'dockerfile' && (!version.exact || !version.digest))) {
    findings.push({
      key: `deps:runtime-unpinned:${image.file}:${image.line}`,
      title: 'Bun image',
      status: 'warn',
      message: image.exact
        ? `${image.value} carries no digest, so a re-pushed tag can change the image.`
        : `${image.value} names no exact Bun release, so the runtime check cannot match it and a rebuild can pick up another release.`,
      suggestion: 'Run guren deploy to write oven/bun:<version>@sha256:<index digest>, or pin the reference by hand.',
      filePath: image.file,
      line: image.line,
    })
  }
  if (check.coverage.status !== 'unavailable' && check.matches.length === 0) {
    findings.push({
      key: 'deps:runtime:none',
      title: 'Bun runtime',
      status: 'pass',
      message: `No oven-sh/bun advisory holds ${check.versions.filter((version) => version.exact).map(describeRuntimeVersion).join(', ') || 'any version found'}.`,
    })
  }
  return findings
}
