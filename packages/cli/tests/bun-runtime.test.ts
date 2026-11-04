import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fetchBunAdvisories,
  inAdvisoryRange,
  judgeRuntime,
  readDockerfileImages,
  readRuntimeVersions,
  runtimeFindings,
  type BunAdvisory,
  type HttpFetch,
} from '../src/bun-runtime'

const DIGEST = `sha256:${'a'.repeat(64)}`

/** The three advisories `oven-sh/bun` had published when the RFC was written, as the API returns them. */
const LIVE = [
  { ghsa_id: 'GHSA-cf8x-9m69-3gg3', severity: 'high', state: 'published', withdrawn_at: null, summary: 'HTTP/3 QPACK amplification', html_url: 'https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3', vulnerabilities: [{ package: { ecosystem: 'npm', name: 'bun' }, vulnerable_version_range: '>= 1.3.14, < 1.4.4', patched_versions: '1.4.4' }] },
  { ghsa_id: 'GHSA-663w-cv8g-jj2p', severity: 'high', state: 'published', withdrawn_at: null, summary: 'Bundled brotli decoder', html_url: 'https://github.com/oven-sh/bun/security/advisories/GHSA-663w-cv8g-jj2p', vulnerabilities: [{ package: { ecosystem: 'npm', name: 'bun' }, vulnerable_version_range: '>= 1.0.21, < 1.4.4', patched_versions: '1.4.4' }] },
  { ghsa_id: 'GHSA-26q8-h657-pf84', severity: 'high', state: 'published', withdrawn_at: null, summary: 'Bundled root certificates', html_url: 'https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84', vulnerabilities: [{ package: { ecosystem: 'npm', name: 'bun' }, vulnerable_version_range: '< 1.4.4', patched_versions: '1.4.4' }] },
]

function serve(pages: Array<{ body: unknown; status?: number; headers?: Record<string, string> }>): { fetch: HttpFetch; calls: Array<{ url: string; auth: string | null }> } {
  const calls: Array<{ url: string; auth: string | null }> = []
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    const page = pages[calls.length - 1]!
    return new Response(JSON.stringify(page.body), { status: page.status ?? 200, headers: page.headers })
  }
  return { fetch, calls }
}

async function liveAdvisories(): Promise<BunAdvisory[]> {
  const read = await fetchBunAdvisories({ fetch: serve([{ body: LIVE }]).fetch, token: '' })
  if (!read.ok) throw new Error(read.reason)
  return read.advisories
}

describe('inAdvisoryRange', () => {
  it('reads GitHub\'s comma ranges by full semver precedence', () => {
    expect(inAdvisoryRange('1.4.4', '>= 1.0.21, < 1.4.4')).toBe(false)
    expect(inAdvisoryRange('1.3.14', '>= 1.3.14, < 1.4.4')).toBe(true)
    expect(inAdvisoryRange('1.0.20', '>= 1.0.21, < 1.4.4')).toBe(false)
    expect(inAdvisoryRange('1.4.4-canary.1', '< 1.4.4')).toBe(true)
    expect(inAdvisoryRange('1.4.5-canary.1', '< 1.4.4')).toBe(false)
    expect(inAdvisoryRange('1.2.3', '= 1.2.3')).toBe(true)
    expect(inAdvisoryRange('2.0.0', '< 1.0.0 || >= 2.0.0')).toBe(true)
  })

  it('returns null for a range it cannot read, instead of the true Bun.semver.satisfies gives', () => {
    expect(inAdvisoryRange('1.4.4', 'garbage')).toBeNull()
    expect(inAdvisoryRange('1.4.4', '')).toBeNull()
  })
})

describe('readDockerfileImages', () => {
  it('reads the images guren deploy writes, ARG defaults and the forms FROM allows', () => {
    const images = readDockerfileImages([
      'ARG BUN=1.4.4',
      `FROM oven/bun:1.4.4@${DIGEST} AS builder`,
      `from --platform=linux/amd64 docker.io/oven/bun:\${BUN}-slim@${DIGEST}`,
      'FROM oven/bun:1-slim',
      'FROM oven/bun',
      'FROM builder AS again',
      'FROM node:22',
    ].join('\n'), 'Dockerfile')

    expect(images.map(({ value, exact, version, line, digest }) => ({ value, exact, version, line, digest: digest !== undefined }))).toEqual([
      { value: `oven/bun:1.4.4@${DIGEST}`, exact: true, version: '1.4.4', line: 2, digest: true },
      { value: `docker.io/oven/bun:\${BUN}-slim@${DIGEST} (docker.io/oven/bun:1.4.4-slim@${DIGEST})`, exact: true, version: '1.4.4', line: 3, digest: true },
      { value: 'oven/bun:1-slim', exact: false, version: undefined, line: 4, digest: false },
      { value: 'oven/bun', exact: false, version: undefined, line: 5, digest: false },
    ])
  })

  it('reads a build argument with no default as naming no exact release', () => {
    expect(readDockerfileImages('FROM oven/bun:${BUN_VERSION}', 'Dockerfile')).toEqual([
      { source: 'dockerfile', value: 'oven/bun:${BUN_VERSION}', exact: false, file: 'Dockerfile', line: 1 },
    ])
  })
})

describe('readRuntimeVersions', () => {
  let dir: string | undefined
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('reads the process, engines.bun, packageManager and every Dockerfile at the root', async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-bun-runtime-'))
    await writeFile(join(dir, 'package.json'), JSON.stringify({ engines: { bun: '>=1.3.0' }, packageManager: 'bun@1.4.3+sha512.abc' }))
    await writeFile(join(dir, 'Dockerfile'), `FROM oven/bun:1.4.4@${DIGEST}\n`)
    await writeFile(join(dir, 'Dockerfile.dev'), 'FROM oven/bun:1\n')

    const versions = await readRuntimeVersions(dir, '1.4.4')

    expect(versions.map(({ source, value, exact, version, file }) => ({ source, value, exact, version, file }))).toEqual([
      { source: 'process', value: '1.4.4', exact: true, version: '1.4.4', file: undefined },
      { source: 'engines', value: '>=1.3.0', exact: false, version: undefined, file: undefined },
      { source: 'packageManager', value: 'bun@1.4.3+sha512.abc', exact: true, version: '1.4.3', file: undefined },
      { source: 'dockerfile', value: `oven/bun:1.4.4@${DIGEST}`, exact: true, version: '1.4.4', file: 'Dockerfile' },
      { source: 'dockerfile', value: 'oven/bun:1', exact: false, version: undefined, file: 'Dockerfile.dev' },
    ])
  })
})

describe('fetchBunAdvisories', () => {
  it('follows every page, and sends the token to api.github.com only', async () => {
    const { fetch, calls } = serve([
      { body: [LIVE[0]], headers: { link: '<https://api.github.com/repositories/1/security-advisories?after=x>; rel="next"' } },
      { body: [LIVE[1], { ...LIVE[2], withdrawn_at: '2026-10-25T00:00:00Z' }], headers: { link: '<https://example.com/next>; rel="next"' } },
      { body: [{ ...LIVE[2], vulnerabilities: [{ package: { ecosystem: 'pip', name: 'bun' }, vulnerable_version_range: '< 1', patched_versions: '1' }] }] },
    ])

    const read = await fetchBunAdvisories({ fetch, token: 'secret' })

    expect(read.ok && read.advisories.map((advisory) => advisory.ghsa)).toEqual(['GHSA-cf8x-9m69-3gg3', 'GHSA-663w-cv8g-jj2p'])
    expect(calls.map((call) => call.auth)).toEqual(['Bearer secret', 'Bearer secret', null])
  })

  it('reads a spent rate limit, an error status and an unrecognised body as unavailable', async () => {
    const limited = await fetchBunAdvisories({ fetch: serve([{ body: {}, status: 403, headers: { 'x-ratelimit-remaining': '0' } }]).fetch, token: '' })
    expect(limited).toEqual({ ok: false, reason: 'GitHub\'s rate limit for unauthenticated requests (60 an hour) is used up; set GITHUB_TOKEN' })
    expect(await fetchBunAdvisories({ fetch: serve([{ body: {}, status: 500 }]).fetch, token: '' })).toEqual({ ok: false, reason: 'api.github.com answered 500' })
    expect(await fetchBunAdvisories({ fetch: serve([{ body: { message: 'no' } }]).fetch, token: '' })).toEqual({ ok: false, reason: 'api.github.com returned an unrecognised advisory list' })
  })
})

describe('judgeRuntime and runtimeFindings', () => {
  it('finds nothing for the patched release, against the live advisories', async () => {
    const check = judgeRuntime([{ source: 'process', value: '1.4.4', exact: true, version: '1.4.4' }], { ok: true, advisories: await liveAdvisories() })

    expect(check.coverage).toEqual({ status: 'complete', reasons: [] })
    expect(runtimeFindings(check).map((finding) => [finding.key, finding.status])).toEqual([['deps:runtime:none', 'pass']])
  })

  it('reports each advisory a version is inside, with the patched release', async () => {
    const check = judgeRuntime([
      { source: 'process', value: '1.3.14', exact: true, version: '1.3.14' },
      { source: 'dockerfile', value: `oven/bun:1.4.4@${DIGEST}`, exact: true, version: '1.4.4', file: 'Dockerfile', line: 1, digest: DIGEST },
    ], { ok: true, advisories: await liveAdvisories() })
    const findings = runtimeFindings(check)

    expect(findings.map((finding) => [finding.key, finding.status])).toEqual([
      ['deps:runtime:GHSA-cf8x-9m69-3gg3', 'fail'],
      ['deps:runtime:GHSA-663w-cv8g-jj2p', 'fail'],
      ['deps:runtime:GHSA-26q8-h657-pf84', 'fail'],
    ])
    expect(findings[0]!.runtime).toMatchObject({ ranges: ['>= 1.3.14, < 1.4.4'], patched: ['1.4.4'] })
    expect(findings[0]!.suggestion).toBe('Move to Bun 1.4.4 (see https://github.com/oven-sh/bun/security/advisories/GHSA-cf8x-9m69-3gg3).')
    expect(check.versions[0]!.advisories).toEqual(['GHSA-cf8x-9m69-3gg3', 'GHSA-663w-cv8g-jj2p', 'GHSA-26q8-h657-pf84'])
    expect(check.versions[1]!.advisories).toBeUndefined()
  })

  it('reports an image short of a version and a digest as unpinned, and the check as partial', () => {
    const check = judgeRuntime([
      { source: 'dockerfile', value: 'oven/bun:1', exact: false, file: 'Dockerfile', line: 1 },
      { source: 'dockerfile', value: 'oven/bun:1.4.4', exact: true, version: '1.4.4', file: 'Dockerfile', line: 2 },
    ], { ok: true, advisories: [] })

    expect(check.coverage.status).toBe('partial')
    expect(runtimeFindings(check).map((finding) => [finding.key, finding.message])).toEqual([
      ['deps:runtime-unpinned:Dockerfile:1', 'oven/bun:1 names no exact Bun release, so the runtime check cannot match it and a rebuild can pick up another release.'],
      ['deps:runtime-unpinned:Dockerfile:2', 'oven/bun:1.4.4 carries no digest, so a re-pushed tag can change the image.'],
      ['deps:runtime:none', 'No oven-sh/bun advisory holds Dockerfile:2 oven/bun:1.4.4.'],
    ])
  })

  it('counts a range it cannot read as holding the version', () => {
    const advisory: BunAdvisory = { ghsa: 'GHSA-x', severity: 'moderate', summary: 'odd', url: 'u', vulnerabilities: [{ range: 'garbage', patched: null }] }
    const check = judgeRuntime([{ source: 'process', value: '1.4.4', exact: true, version: '1.4.4' }], { ok: true, advisories: [advisory] })

    expect(check.coverage.reasons.map((reason) => reason.code)).toEqual(['unreadable-range'])
    expect(runtimeFindings(check).map((finding) => [finding.key, finding.status])).toEqual([['deps:runtime:GHSA-x', 'warn']])
  })

  it('never reads a failed request as clean', () => {
    const check = judgeRuntime([{ source: 'process', value: '1.3.14', exact: true, version: '1.3.14' }], { ok: false, reason: 'api.github.com answered 500' })

    expect(check.coverage.status).toBe('unavailable')
    expect(runtimeFindings(check).map((finding) => [finding.key, finding.status])).toEqual([['deps:runtime-scan', 'warn']])
  })
})
