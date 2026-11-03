/**
 * The `oven/bun` images `guren deploy` writes into a Dockerfile (RFC 0039 §6): the
 * exact Bun running the command, pinned to the digest of the tag's multi-platform
 * index so a re-pushed tag cannot change the image. A platform manifest's digest
 * would pin one architecture, so only an index answer is pinned.
 */

export interface BunImages {
  builder: string
  runtime: string
  /** Why an image is less pinned than `name:version@digest`, one line each. */
  notes: string[]
}

export type RegistryFetch = (url: string, init?: RequestInit) => Promise<Response>

const REPOSITORY = 'oven/bun'
const TOKEN_URL = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPOSITORY}:pull`
const MANIFEST_URL = `https://registry-1.docker.io/v2/${REPOSITORY}/manifests/`
const INDEX_MEDIA_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u
const STABLE_VERSION = /^(\d+)\.\d+\.\d+$/u
const REGISTRY_TIMEOUT_MS = 5_000

type Lookup = { kind: 'digest'; digest: string } | { kind: 'missing-tag' } | { kind: 'unavailable'; reason: string }

async function fetchToken(fetchImpl: RegistryFetch, signal: AbortSignal): Promise<string> {
  const response = await fetchImpl(TOKEN_URL, { signal })
  if (!response.ok) throw new Error(`auth.docker.io answered ${response.status}`)
  const body = await response.json() as { token?: unknown }
  if (typeof body.token !== 'string') throw new Error('auth.docker.io returned no token')
  return body.token
}

async function lookupDigest(fetchImpl: RegistryFetch, token: string, tag: string, signal: AbortSignal): Promise<Lookup> {
  // HEAD carries the digest header without the manifest body.
  const response = await fetchImpl(`${MANIFEST_URL}${tag}`, {
    method: 'HEAD',
    headers: { Authorization: `Bearer ${token}`, Accept: INDEX_MEDIA_TYPES.join(', ') },
    signal,
  })
  if (response.status === 404) return { kind: 'missing-tag' }
  if (!response.ok) return { kind: 'unavailable', reason: `the registry answered ${response.status}` }
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!INDEX_MEDIA_TYPES.includes(mediaType)) {
    return { kind: 'unavailable', reason: `the tag is not a multi-platform index (${mediaType || 'no content type'})` }
  }
  const digest = response.headers.get('docker-content-digest') ?? ''
  if (!DIGEST_PATTERN.test(digest)) return { kind: 'unavailable', reason: 'the registry returned no sha256 digest' }
  return { kind: 'digest', digest }
}

function floating(major: string, notes: string[]): BunImages {
  return { builder: `${REPOSITORY}:${major}`, runtime: `${REPOSITORY}:${major}-slim`, notes }
}

/**
 * `bunVersion` is the running Bun's (`process.versions.bun`), or undefined under
 * Node. A version Docker Hub has no tag for (a canary, or one not published as an
 * image yet) falls back to the floating major tag, since an exact tag that does not
 * exist would fail the build; a registry that does not answer keeps the exact tag.
 */
export async function resolveBunImages(bunVersion: string | undefined, fetchImpl: RegistryFetch = fetch): Promise<BunImages> {
  const stable = bunVersion ? STABLE_VERSION.exec(bunVersion) : null
  if (!bunVersion || !stable) {
    return floating('1', [
      bunVersion
        ? `Bun ${bunVersion} is not a release with an ${REPOSITORY} image; the Dockerfile uses ${REPOSITORY}:1 and ${REPOSITORY}:1-slim, which move with every Bun release.`
        : `guren deploy is not running under Bun, so the Dockerfile uses ${REPOSITORY}:1 and ${REPOSITORY}:1-slim, which move with every Bun release.`,
    ])
  }
  const major = stable[1]!
  const tags = { builder: bunVersion, runtime: `${bunVersion}-slim` }

  let lookups: Record<keyof typeof tags, Lookup>
  try {
    const signal = AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
    const token = await fetchToken(fetchImpl, signal)
    const [builder, runtime] = await Promise.all([
      lookupDigest(fetchImpl, token, tags.builder, signal),
      lookupDigest(fetchImpl, token, tags.runtime, signal),
    ])
    lookups = { builder, runtime }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    lookups = { builder: { kind: 'unavailable', reason }, runtime: { kind: 'unavailable', reason } }
  }

  if (lookups.builder.kind === 'missing-tag' || lookups.runtime.kind === 'missing-tag') {
    return floating(major, [
      `Docker Hub has no ${REPOSITORY}:${tags.builder} or ${REPOSITORY}:${tags.runtime} image yet; the Dockerfile uses ${REPOSITORY}:${major} and ${REPOSITORY}:${major}-slim, which move with every Bun release. Run guren deploy --force again once the image is published.`,
    ])
  }

  const notes: string[] = []
  const pin = (stage: keyof typeof tags): string => {
    const lookup = lookups[stage]
    const image = `${REPOSITORY}:${tags[stage]}`
    if (lookup.kind === 'digest') return `${image}@${lookup.digest}`
    notes.push(`${image} is not pinned to a digest (${lookup.kind === 'unavailable' ? lookup.reason : 'no tag'}), so a re-pushed tag would change it. Run guren deploy --force again to pin it.`)
    return image
  }
  return { builder: pin('builder'), runtime: pin('runtime'), notes }
}
