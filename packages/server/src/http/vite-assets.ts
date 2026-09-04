import { resolve } from 'node:path'
import {
  loadViteManifest,
  getManifestFile,
  clientManifestCandidates,
  injectedClientManifest,
  isViteProduction,
  normalizeDevServerUrl,
  DEFAULT_DEV_SERVER_URL,
  INJECTED_CLIENT_MANIFEST_SOURCE,
  PUBLIC_ASSETS_URL_PREFIX,
  type ViteManifest,
} from './vite-manifest'
import { trimSlashes } from '../support/trim-slashes'

/**
 * Options for {@link viteAsset}. Ordinary applications call
 * `viteAsset(entry)` with no options; `manifestPaths` exists for tests and
 * unusual layouts.
 */
export interface ViteAssetOptions {
  /**
   * Vite manifest candidate paths (absolute, or relative to the working
   * directory). Defaults to the standard build output locations.
   */
  manifestPaths?: string[]
}

let defaultCandidates: string[] | undefined
const manifestCache = new Map<string, ViteManifest | null>()

/** @internal Test seam — clears the memoized manifest reads. */
export function __resetViteAssetCache(): void {
  defaultCandidates = undefined
  manifestCache.clear()
}

/**
 * One manifest resolution, memoized until {@link __resetViteAssetCache}. `null`
 * records "looked and found nothing" so absence is not re-probed per render.
 */
function memoizedManifest(key: string, load: () => ViteManifest | undefined): ViteManifest | null {
  let manifest = manifestCache.get(key)
  if (manifest === undefined) {
    manifest = load() ?? null
    manifestCache.set(key, manifest)
  }
  return manifest
}

/** The production tail: hashed output file → served URL, or the loud throw. */
function manifestAssetUrl(manifest: ViteManifest, normalizedEntry: string): string {
  const file = getManifestFile(manifest[normalizedEntry])
  if (!file) {
    throw new Error(
      `viteAsset(): "${normalizedEntry}" is not in the Vite manifest at ${manifest.__path__ ?? 'an unknown path'}. ` +
        'Declare it as a build input in vite.config.ts (build.rollupOptions.input) so Vite emits and records it.',
    )
  }

  return `${PUBLIC_ASSETS_URL_PREFIX}${trimSlashes(file)}`
}

/**
 * Resolve the public URL of a Vite build input, for server-rendered content
 * pages (RFC 0014): the dev server URL in development, the hashed manifest
 * entry under `/public/assets/` in production. Throws with the paths tried
 * rather than returning an empty string. Production prefers a build-time
 * injected manifest (`GUREN_VITE_MANIFEST`) over the filesystem, so `view()`
 * pages work on serverless targets; an explicit `manifestPaths` still reads
 * exactly the named files. A CSS file bundled *through* a JS entry has no
 * manifest key of its own — declare it in `build.rollupOptions.input`.
 *
 * @example
 * ```tsx
 * <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
 * ```
 */
export function viteAsset(entry: string, options: ViteAssetOptions = {}): string {
  const normalizedEntry = trimSlashes(entry)
  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (!isViteProduction(devServerUrl)) {
    const base = normalizeDevServerUrl(devServerUrl ?? DEFAULT_DEV_SERVER_URL)
    return `${base}/${normalizedEntry}`
  }

  if (!options.manifestPaths) {
    const injected = memoizedManifest(INJECTED_CLIENT_MANIFEST_SOURCE, injectedClientManifest)
    if (injected) {
      return manifestAssetUrl(injected, normalizedEntry)
    }
  }

  const candidates = options.manifestPaths
    ? options.manifestPaths.map((path) => resolve(path))
    : (defaultCandidates ??= clientManifestCandidates())
  const manifest = memoizedManifest(candidates.join('\n'), () =>
    loadViteManifest(candidates, 'client', { warnOnMissing: false }),
  )

  if (!manifest) {
    throw new Error(
      `viteAsset(): no Vite manifest found. Checked:\n${candidates
        .map((path) => `  - ${path}`)
        .join('\n')}\n` +
        'Run `bunx vite build` before starting in production, or pass { manifestPaths } pointing at the build output.',
    )
  }

  return manifestAssetUrl(manifest, normalizedEntry)
}
