import { readFileSync } from 'node:fs'

/**
 * Vite manifest reading, shared between the Inertia asset wiring
 * (`inertia-assets.ts`) and the content-page `viteAsset()` helper
 * (`vite-assets.ts`, RFC 0014). Factored out so the two cannot drift on
 * what counts as a manifest or where one may live.
 */

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
      Object.defineProperty(manifest, '__raw__', {
        value: raw,
        enumerable: false,
      })
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
