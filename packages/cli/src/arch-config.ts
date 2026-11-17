import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findFirstLoadable } from './discovery'
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

  const optionsError = moduleBoundariesError(config.moduleBoundaries)
  if (optionsError) {
    return { config: null, loadError: `${resolvedFile}: ${optionsError}` }
  }

  return { config: config as ArchRuleSet }
}

/** A misspelt opt-in would read as off, and the boundary it asked for would pass unchecked. */
function moduleBoundariesError(value: unknown): string | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '`moduleBoundaries` must be an object.'
  }
  const options = value as Record<string, unknown>
  const unknownKey = Object.keys(options).find((key) => key !== 'includeTypeImports')
  if (unknownKey !== undefined) {
    return `\`moduleBoundaries\` has no option \`${unknownKey}\`; the one it takes is \`includeTypeImports\`.`
  }
  if (options.includeTypeImports !== undefined && typeof options.includeTypeImports !== 'boolean') {
    return '`moduleBoundaries.includeTypeImports` must be a boolean.'
  }
  return null
}

async function resolveConfigFile(cwd: string): Promise<string | undefined> {
  const found = await findFirstLoadable(cwd, CANDIDATE_FILES)
  return found === null ? undefined : resolve(cwd, found)
}
