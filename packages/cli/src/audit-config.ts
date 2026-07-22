import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileExists } from './discovery'

export interface AuditIgnoreEntry {
  /** Must match `AuditFinding.key` exactly (no globs). */
  key: string
  /** Required — undocumented/empty reasons are rejected. */
  reason: string
}

export interface AuditConfig {
  ignore: AuditIgnoreEntry[]
}

export interface LoadedAuditConfig {
  /** Entries with a non-empty `reason`. Entries missing one are reported via `invalidEntries`. */
  entries: AuditIgnoreEntry[]
  /** Raw entries that were rejected for missing/empty `reason`. */
  invalidEntries: AuditIgnoreEntry[]
  /** Set when the config file exists but failed to load or has an unexpected shape. */
  loadError?: string
}

const CANDIDATE_FILES = ['config/audit.ts', 'config/audit.js', 'config/audit.mjs']

function emptyResult(loadError?: string): LoadedAuditConfig {
  return { entries: [], invalidEntries: [], loadError }
}

function isAuditIgnoreEntry(value: unknown): value is AuditIgnoreEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.key === 'string' && candidate.key.length > 0
}

/**
 * Loads `config/audit.{ts,js,mjs}` (or an explicit `configFile`) and returns
 * its ignore entries split into valid/invalid. Returns an empty result
 * (no `loadError`) when no config file exists — ignore support is opt-in.
 *
 * Imported without cache-busting: unlike `load-routes.ts` (re-imported on
 * every file save under Vite's dev watcher), this only ever runs once per
 * `guren audit` CLI invocation, so there's no stale-module-cache risk to
 * guard against.
 */
export async function loadAuditConfig(
  cwd: string,
  configFile?: string,
): Promise<LoadedAuditConfig> {
  const resolvedFile = await resolveConfigFile(cwd, configFile)
  if (!resolvedFile) {
    return emptyResult()
  }

  let moduleExports: Record<string, unknown>
  try {
    moduleExports = (await import(pathToFileURL(resolvedFile).href)) as Record<string, unknown>
  } catch (error) {
    return emptyResult(
      `Failed to load ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const config = moduleExports.default as Partial<AuditConfig> | undefined
  if (!config || !Array.isArray(config.ignore)) {
    return emptyResult(`${resolvedFile} must export a default object with an \`ignore\` array.`)
  }

  const entries: AuditIgnoreEntry[] = []
  const invalidEntries: AuditIgnoreEntry[] = []

  for (const raw of config.ignore) {
    if (!isAuditIgnoreEntry(raw)) continue
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
    if (reason.length === 0) {
      invalidEntries.push(raw)
      continue
    }
    entries.push({ key: raw.key, reason })
  }

  return { entries, invalidEntries }
}

async function resolveConfigFile(cwd: string, configFile?: string): Promise<string | undefined> {
  // An explicit path is always resolved and handed to the caller, even if it
  // doesn't exist — the subsequent import() failure surfaces a clear error.
  if (configFile) {
    return resolve(cwd, configFile)
  }

  for (const candidate of CANDIDATE_FILES) {
    if (await fileExists(cwd, candidate)) {
      return resolve(cwd, candidate)
    }
  }

  return undefined
}
