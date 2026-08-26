import { resolve } from 'node:path'
import {
  loadViteManifest,
  getManifestFile,
  clientManifestCandidates,
  isViteProduction,
  normalizeDevServerUrl,
  DEFAULT_DEV_SERVER_URL,
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
 * **Serverless caveat:** production resolution reads the manifest from the
 * filesystem, which bundled deploy targets (Cloudflare Workers, Vercel,
 * Lambda) do not ship — their deploy plugins resolve assets at build time
 * for Inertia and do not yet feed this helper. On those targets `viteAsset`
 * throws at first render until the deploy plugins gain a build-time manifest
 * injection; track that as the follow-up before using `view()` there.
 */
export function viteAsset(entry: string, options: ViteAssetOptions = {}): string {
  const normalizedEntry = trimSlashes(entry)
  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (!isViteProduction(devServerUrl)) {
    const base = normalizeDevServerUrl(devServerUrl ?? DEFAULT_DEV_SERVER_URL)
    return `${base}/${normalizedEntry}`
  }

  const candidates = options.manifestPaths
    ? options.manifestPaths.map((path) => resolve(path))
    : (defaultCandidates ??= clientManifestCandidates())
  const cacheKey = candidates.join('\n')
  let manifest = manifestCache.get(cacheKey)
  if (manifest === undefined) {
    manifest = loadViteManifest(candidates, 'client', { warnOnMissing: false }) ?? null
    manifestCache.set(cacheKey, manifest)
  }

  if (!manifest) {
    throw new Error(
      `viteAsset(): no Vite manifest found. Checked:\n${candidates
        .map((path) => `  - ${path}`)
        .join('\n')}\n` +
        'Run `bunx vite build` before starting in production, or pass { manifestPaths } pointing at the build output.',
    )
  }

  const file = getManifestFile(manifest[normalizedEntry])
  if (!file) {
    throw new Error(
      `viteAsset(): "${normalizedEntry}" is not in the Vite manifest at ${manifest.__path__ ?? 'an unknown path'}. ` +
        'Declare it as a build input in vite.config.ts (build.rollupOptions.input) so Vite emits and records it.',
    )
  }

  return `${PUBLIC_ASSETS_URL_PREFIX}${trimSlashes(file)}`
}
