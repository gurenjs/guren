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
 * One manifest resolution, memoized until {@link __resetViteAssetCache}.
 * `null` records "looked and found nothing" so absence is not re-probed per
 * render. The injected manifest shares the cache under its fixed source
 * label, which cannot collide with the other keys — those are joined
 * absolute paths.
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
 * pages (RFC 0014). The URL is environment-dependent and this helper owns
 * both branches:
 *
 * - **Development** (a dev server is configured, or `NODE_ENV` is not
 *   `production`): the Vite dev server serves the source path directly, so
 *   this returns `${devServerUrl}/${entry}`.
 * - **Production**: the entry is looked up in the Vite build manifest and the
 *   hashed output file is returned under the `/public/assets/` route that
 *   `configureInertiaAssets` serves with immutable caching.
 *
 * Fails loudly: an unresolvable manifest or an entry the manifest does not
 * record throws with the paths tried and the likely fix — never a silent
 * empty string.
 *
 * @example
 * ```tsx
 * <link rel="stylesheet" href={viteAsset('resources/css/app.css')} />
 * ```
 *
 * Note a CSS file bundled *through* a JS entry (imported from `app.tsx`) has
 * no manifest key of its own — declare it as an explicit build input in
 * `vite.config.ts` (`build.rollupOptions.input`) so Vite emits and records
 * it.
 *
 * **Serverless targets:** production resolution prefers a build-time
 * injected manifest over the filesystem — when `GUREN_VITE_MANIFEST` holds
 * the client manifest JSON, entries resolve from it and no file is read. The
 * deploy plugins (`@guren/plugin-cloudflare`, `@guren/plugin-vercel`,
 * `@guren/plugin-lambda`) populate it during their build step, so `view()`
 * pages work on targets whose runtime never sees
 * `public/assets/manifest.json`. An explicit `manifestPaths` still reads the
 * named files — a caller stating paths is asking for exactly those.
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
