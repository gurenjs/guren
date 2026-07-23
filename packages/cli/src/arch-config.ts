import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileExists } from './discovery'
import type { ArchRuleSet } from './arch/index'

export interface LoadedArchConfig {
  config: ArchRuleSet | null
  /** Set when a config file exists but failed to load or has an unexpected shape. */
  loadError?: string
}

const CANDIDATE_FILES = ['guren.arch.ts', 'guren.arch.js', 'guren.arch.mjs']

/**
 * Loads `guren.arch.ts` (or `.js`/`.mjs`) from the project root. Returns
 * `{ config: null }` with no `loadError` when no config file exists —
 * architecture checking is opt-in.
 *
 * Imported without cache-busting: like `audit-config.ts`'s loader, this only
 * ever runs once per `guren check` CLI invocation, so there's no stale
 * module-cache risk to guard against.
 */
export async function loadArchConfig(cwd: string): Promise<LoadedArchConfig> {
  const resolvedFile = await resolveConfigFile(cwd)
  if (!resolvedFile) {
    return { config: null }
  }

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = (await import(pathToFileURL(resolvedFile).href)) as Record<string, unknown>
  } catch (error) {
    return {
      config: null,
      loadError: `Failed to load ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const config = moduleExports.default as Partial<ArchRuleSet> | undefined
  if (!config || !Array.isArray(config.rules)) {
    return {
      config: null,
      loadError: `${resolvedFile} must export a default object from defineArchRules() with a \`rules\` array.`,
    }
  }

  return { config: config as ArchRuleSet }
}

async function resolveConfigFile(cwd: string): Promise<string | undefined> {
  for (const candidate of CANDIDATE_FILES) {
    if (await fileExists(cwd, candidate)) {
      return resolve(cwd, candidate)
    }
  }

  return undefined
}
