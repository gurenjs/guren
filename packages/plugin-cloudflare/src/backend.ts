import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type CloudflareBackend = 'cf' | 'wrangler'

/**
 * RFC 0035 §7: `cf` when the app has `cloudflare.config.ts` and declares `cf`,
 * otherwise Wrangler. The config without the package is refused rather than
 * falling back, which would scaffold a wrangler.jsonc beside it.
 */
export function detectCloudflareBackend(root: string): CloudflareBackend {
  if (!existsSync(resolve(root, 'cloudflare.config.ts'))) {
    return 'wrangler'
  }
  if (!appDeclares(root, 'cf')) {
    throw new Error(
      `Cloudflare build: ${resolve(root, 'cloudflare.config.ts')} exists, but this app does not declare the cf CLI that reads it. Install it:\n`
      + '  bun add -d cf wrangler\n'
      + 'Or remove cloudflare.config.ts to keep deploying through wrangler.jsonc.',
    )
  }
  return 'cf'
}

/** Whether the app declares `name` at all: a CLI like `cf` belongs in devDependencies. */
function appDeclares(root: string, name: string): boolean {
  const manifest = readPackageJson(root)
  return (manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]) !== undefined
}

export interface PackageJsonLike {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** The app's package.json; an absent, unreadable or malformed one reads as `{}`, and a non-object field as absent. */
export function readPackageJson(root: string): PackageJsonLike {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  } catch {
    return {}
  }
  if (!isRecord(manifest)) return {}
  const record = (value: unknown) => (isRecord(value) ? (value as Record<string, string>) : undefined)
  return {
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
    scripts: record(manifest.scripts),
    dependencies: record(manifest.dependencies),
    devDependencies: record(manifest.devDependencies),
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
