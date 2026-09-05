import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { trimTrailingSlashes } from '../support/trim-slashes'

/**
 * The one rule for how Vite build output is found and addressed, shared by the
 * Inertia asset wiring (`inertia-assets.ts`) and `viteAsset()` (`vite-assets.ts`,
 * RFC 0014) so the two cannot drift: what counts as a manifest, where one may
 * live, which URL prefix serves the hashed files, and what "the dev server is
 * on" means.
 */

/** Where `configureInertiaAssets` serves hashed build output from. */
export const PUBLIC_ASSETS_URL_PREFIX = '/public/assets/'

/** The Vite default the framework assumes when no dev-server URL is set. */
export const DEFAULT_DEV_SERVER_URL = 'http://localhost:5173'

/**
 * Production for *asset* purposes: `NODE_ENV` says so and no dev server is
 * configured — a configured dev server means dev asset serving even when
 * `NODE_ENV` is `production` (E2E runs do exactly this).
 */
export function isViteProduction(
  devServerUrl: string | undefined = process.env.VITE_DEV_SERVER_URL,
): boolean {
  return (process.env.NODE_ENV ?? 'development') === 'production' && typeof devServerUrl !== 'string'
}

export function normalizeDevServerUrl(value: string): string {
  if (!value) {
    return value
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return trimmed
  }

  const stripped = trimTrailingSlashes(trimmed)
  return stripped.length > 0 ? stripped : '/'
}

/**
 * Candidate client-manifest locations, `.vite/manifest.json` first: Vite >= 5
 * writes it there, so a flat `manifest.json` is likely a stale leftover. The
 * deploy plugins order the same pair through `@guren/core`'s deploy-build
 * helpers and must agree, or an app with both layouts resolves different asset
 * versions after a serverless deploy; `tests/http/vite-manifest.test.ts` pins it.
 */
export function clientManifestCandidates(baseDir?: string): string[] {
  const root = baseDir ?? process.cwd()
  return [
    resolve(root, 'public/assets/.vite/manifest.json'),
    resolve(root, 'public/assets/manifest.json'),
  ]
}

/**
 * `__path__` label for an injected manifest, so "entry not in the manifest"
 * errors name the real source rather than a path that was never read.
 */
export const INJECTED_CLIENT_MANIFEST_SOURCE = 'GUREN_VITE_MANIFEST (injected by the deploy build)'

const INJECTED_MANIFEST_HINT =
  'It must hold the Vite client manifest text (deploy plugins inject it at build time), not a path.'

/**
 * Attach one of the manifest's bookkeeping fields. `enumerable: false` is the
 * invariant: a stamped field must never leak into `Object.keys` or a
 * re-serialization of the manifest.
 */
function defineHidden(manifest: ViteManifest, key: '__path__' | '__raw__', value: string): void {
  Object.defineProperty(manifest, key, { value, enumerable: false })
}

/**
 * The client manifest a deploy build injected for runtimes that do not ship
 * `public/assets/manifest.json`: `GUREN_VITE_MANIFEST` holds the manifest *JSON
 * text*, not a path. Fails loudly on a value that is set but not a manifest,
 * because falling through to the filesystem would end in "run `bunx vite build`"
 * — a diagnosis pointing away from the variable that is actually broken.
 */
export function injectedClientManifest(): ViteManifest | undefined {
  // This one exact member expression on purpose: the Vercel plugin substitutes
  // it with a bundler `define`, which matches nothing else — an optional chain
  // or an indexed read silently opts back into a runtime read serverless
  // bundles cannot answer. Pinned by tests/env-gate-form.test.ts.
  const raw = process.env.GUREN_VITE_MANIFEST
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`GUREN_VITE_MANIFEST is set but is not valid JSON. ${INJECTED_MANIFEST_HINT}`, {
      cause: error,
    })
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `GUREN_VITE_MANIFEST is set but does not hold a manifest object. ${INJECTED_MANIFEST_HINT}`,
    )
  }

  const manifest = parsed as ViteManifest
  defineHidden(manifest, '__path__', INJECTED_CLIENT_MANIFEST_SOURCE)
  return manifest
}

export type ViteManifestEntryObject = {
  file: string
  css?: string[]
  assets?: string[]
  imports?: string[]
  dynamicImports?: string[]
}

export type ViteManifestValue = ViteManifestEntryObject | string[]

export type ViteManifest = Record<string, ViteManifestValue> & { __path__?: string; __raw__?: string }

export interface LoadViteManifestOptions {
  /**
   * Emit console warnings when no manifest is found (the Inertia wiring's
   * behavior). `viteAsset()` passes `false` and throws instead.
   */
  warnOnMissing?: boolean
  /**
   * Retain the raw manifest text as `__raw__`. Off by default: only the Inertia
   * wiring hashes it, and caches should not pin JSON text nothing reads.
   */
  includeRaw?: boolean
}

export function loadViteManifest(
  candidatePaths: string[],
  label: 'client' | 'SSR',
  options: LoadViteManifestOptions = {},
): ViteManifest | undefined {
  const warnOnMissing = options.warnOnMissing ?? true
  const command = label === 'SSR' ? 'bunx vite build --ssr' : 'bunx vite build'

  for (const manifestPath of candidatePaths) {
    try {
      const raw = readFileSync(manifestPath, 'utf8')
      const manifest = JSON.parse(raw) as ViteManifest
      defineHidden(manifest, '__path__', manifestPath)
      if (options.includeRaw) {
        defineHidden(manifest, '__raw__', raw)
      }
      return manifest
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Unable to load ${label} Vite manifest at ${manifestPath}.`, error)
        return undefined
      }
    }
  }

  if (warnOnMissing && candidatePaths.length) {
    console.warn(
      `Unable to load ${label} Vite manifest. Checked paths:\n${candidatePaths
        .map((p) => `  - ${p}`)
        .join('\n')}\nRun \`${command}\` before starting in production.`,
    )
  }

  return undefined
}

export function getManifestFile(
  entry: ViteManifestValue | string | undefined,
): string | undefined {
  if (!entry) {
    return undefined
  }

  if (Array.isArray(entry)) {
    return entry[0]
  }

  if (typeof entry === 'string') {
    return entry
  }

  if ('file' in entry && typeof entry.file === 'string') {
    return entry.file
  }

  return undefined
}

export function getManifestCss(
  entry: ViteManifestValue | string | undefined,
): string[] | undefined {
  if (!entry || Array.isArray(entry) || typeof entry === 'string') {
    return undefined
  }

  return entry.css
}
