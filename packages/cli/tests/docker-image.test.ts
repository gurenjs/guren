import { describe, expect, it } from 'bun:test'
import { resolveBunImages, type RegistryFetch } from '../src/docker-image'

const INDEX = 'application/vnd.oci.image.index.v1+json'
const BUILDER_DIGEST = `sha256:${'a'.repeat(64)}`
const RUNTIME_DIGEST = `sha256:${'b'.repeat(64)}`

interface Recorded { url: string; init?: RequestInit }

function registry(manifest: (tag: string) => Response): { fetch: RegistryFetch; calls: Recorded[] } {
  const calls: Recorded[] = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith('https://auth.docker.io/')) return Response.json({ token: 'anonymous' })
      return manifest(url.slice(url.lastIndexOf('/') + 1))
    },
  }
}

function indexAnswer(tag: string): Response {
  const digest = tag.endsWith('-slim') ? RUNTIME_DIGEST : BUILDER_DIGEST
  return new Response(null, { status: 200, headers: { 'content-type': INDEX, 'docker-content-digest': digest } })
}

describe('resolveBunImages', () => {
  it('pins both stages to the exact Bun version and its index digest', async () => {
    const { fetch, calls } = registry(indexAnswer)

    const images = await resolveBunImages('1.4.4', fetch)

    expect(images).toEqual({
      builder: `oven/bun:1.4.4@${BUILDER_DIGEST}`,
      runtime: `oven/bun:1.4.4-slim@${RUNTIME_DIGEST}`,
      notes: [],
    })
    const manifests = calls.filter((call) => call.url.includes('/manifests/'))
    expect(manifests.map((call) => call.url)).toEqual([
      'https://registry-1.docker.io/v2/oven/bun/manifests/1.4.4',
      'https://registry-1.docker.io/v2/oven/bun/manifests/1.4.4-slim',
    ])
    for (const call of manifests) {
      expect(call.init?.method).toBe('HEAD')
      const headers = new Headers(call.init?.headers)
      expect(headers.get('authorization')).toBe('Bearer anonymous')
      expect(headers.get('accept')).toContain(INDEX)
    }
  })

  it('leaves a stage unpinned when the tag answers with a single-platform manifest', async () => {
    const { fetch } = registry((tag) => tag.endsWith('-slim')
      ? new Response(null, { headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'docker-content-digest': RUNTIME_DIGEST } })
      : indexAnswer(tag))

    const images = await resolveBunImages('1.4.4', fetch)

    expect(images.builder).toBe(`oven/bun:1.4.4@${BUILDER_DIGEST}`)
    expect(images.runtime).toBe('oven/bun:1.4.4-slim')
    expect(images.notes).toHaveLength(1)
    expect(images.notes[0]).toContain('not a multi-platform index')
  })

  it('leaves a stage unpinned when the digest header is not a sha256 digest', async () => {
    const { fetch } = registry(() => new Response(null, { headers: { 'content-type': INDEX, 'docker-content-digest': 'sha256:short' } }))

    const images = await resolveBunImages('1.4.4', fetch)

    expect(images.builder).toBe('oven/bun:1.4.4')
    expect(images.runtime).toBe('oven/bun:1.4.4-slim')
    expect(images.notes).toHaveLength(2)
  })

  it('keeps the exact tags without digests when the registry cannot be reached', async () => {
    const fetch: RegistryFetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND auth.docker.io')
    }

    const images = await resolveBunImages('1.4.4', fetch)

    expect(images.builder).toBe('oven/bun:1.4.4')
    expect(images.runtime).toBe('oven/bun:1.4.4-slim')
    expect(images.notes).toHaveLength(2)
    expect(images.notes[0]).toContain('ENOTFOUND')
  })

  it('falls back to the floating major tag when Docker Hub has no image for the version', async () => {
    const { fetch } = registry((tag) => tag.endsWith('-slim') ? new Response(null, { status: 404 }) : indexAnswer(tag))

    const images = await resolveBunImages('1.4.5', fetch)

    expect(images.builder).toBe('oven/bun:1')
    expect(images.runtime).toBe('oven/bun:1-slim')
    expect(images.notes).toHaveLength(1)
    expect(images.notes[0]).toContain('no oven/bun:1.4.5')
  })

  it('uses the floating tag for a Bun build that is not a release, without asking the registry', async () => {
    const { fetch, calls } = registry(indexAnswer)

    const images = await resolveBunImages('1.5.0-canary.20261103', fetch)

    expect(images.builder).toBe('oven/bun:1')
    expect(images.runtime).toBe('oven/bun:1-slim')
    expect(images.notes[0]).toContain('1.5.0-canary.20261103')
    expect(calls).toEqual([])
  })

  it('uses the floating tag when the command does not run under Bun', async () => {
    const { fetch, calls } = registry(indexAnswer)

    const images = await resolveBunImages(undefined, fetch)

    expect(images.builder).toBe('oven/bun:1')
    expect(images.notes[0]).toContain('not running under Bun')
    expect(calls).toEqual([])
  })
})
