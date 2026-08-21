import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findFirstLoadable } from './discovery'

export interface AuditIgnoreEntry {
  /** Must match `AuditFinding.key` exactly (no globs). */
  key: string
  /** Required — undocumented/empty reasons are rejected. */
  reason: string
}

/** A raw ignore entry that failed validation — `key` is a best-effort label for reporting. */
export interface InvalidAuditIgnoreEntry {
  key: string
  issue: 'missing-key' | 'missing-reason'
}

export interface AuditConfig {
  /** Unvalidated at the type level — entries are runtime-checked in `loadAuditConfig`. */
  ignore: unknown[]
}

export interface LoadedAuditConfig {
  /** Entries with both a non-empty `key` and `reason`. */
  entries: AuditIgnoreEntry[]
  /** Raw entries rejected for a missing `key` and/or `reason`. */
  invalidEntries: InvalidAuditIgnoreEntry[]
  /** Set when the config file exists but failed to load or has an unexpected shape. */
  loadError?: string
}

const CANDIDATE_FILES = ['config/audit.ts', 'config/audit.js', 'config/audit.mjs']

function emptyResult(loadError?: string): LoadedAuditConfig {
  return { entries: [], invalidEntries: [], loadError }
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
  const invalidEntries: InvalidAuditIgnoreEntry[] = []

  for (const raw of config.ignore) {
    const candidate = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : ''
    const reason = typeof candidate.reason === 'string' ? candidate.reason.trim() : ''

    if (key.length === 0) {
      invalidEntries.push({ key: '<missing key>', issue: 'missing-key' })
      continue
    }
    if (reason.length === 0) {
      invalidEntries.push({ key, issue: 'missing-reason' })
      continue
    }
    entries.push({ key, reason })
  }

  return { entries, invalidEntries }
}

async function resolveConfigFile(cwd: string, configFile?: string): Promise<string | undefined> {
  // An explicit path is always resolved and handed to the caller, even if it
  // doesn't exist — the subsequent import() failure surfaces a clear error.
  if (configFile) {
    return resolve(cwd, configFile)
  }

  const found = await findFirstLoadable(cwd, CANDIDATE_FILES)
  return found === null ? undefined : resolve(cwd, found)
}
