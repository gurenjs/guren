import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { trimTrailingSlashes } from '../support/trim-slashes'

/**
 * The one rule for how Vite build output is found and addressed, shared
 * between the Inertia asset wiring (`inertia-assets.ts`) and the content-page
 * `viteAsset()` helper (`vite-assets.ts`, RFC 0014): what counts as a
 * manifest, where one may live, which URL prefix serves the hashed files,
 * and what "the dev server is on" means. Factored out so the two consumers
 * cannot drift on any of it.
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
 * Candidate client-manifest locations under a project root, in preference
 * order. `baseDir` defaults to the working directory (`viteAsset()`'s
 * anchor); the Inertia wiring passes the root it derives from the app entry
 * module.
 */
export function clientManifestCandidates(baseDir?: string): string[] {
  const root = baseDir ?? process.cwd()
  return [
    resolve(root, 'public/assets/manifest.json'),
    resolve(root, 'public/assets/.vite/manifest.json'),
  ]
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
   * behavior). `viteAsset()` passes `false` and throws its own error instead
   * — a warning can scroll past, a missing stylesheet URL cannot.
   */
  warnOnMissing?: boolean
  /**
   * Retain the raw manifest text as `__raw__` on the result. Off by default:
   * only the Inertia wiring hashes it (for the build id), and long-lived
   * caches should not pin hundreds of KB of JSON text nothing reads.
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
      Object.defineProperty(manifest, '__path__', {
        value: manifestPath,
        enumerable: false,
      })
      if (options.includeRaw) {
        Object.defineProperty(manifest, '__raw__', {
          value: raw,
          enumerable: false,
        })
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
