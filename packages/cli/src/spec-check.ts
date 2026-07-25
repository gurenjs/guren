import { resolve } from 'node:path'
import { readIfExists, directoryExists } from './discovery'
import { generateSpecArtifacts, SPEC_DIR } from './spec-generate'
import { check, type CheckResult } from './check-result'

export interface SpecCheckOptions {
  cwd: string
  routesFile?: string
  /** Skip regeneration entirely when no spec-relevant file changed. */
  changedFiles?: Set<string> | null
}

/**
 * Files whose change can alter a spec view. `check --changed` (the
 * edit-hook path) only pays for spec regeneration when one of these
 * changed — everything the four views derive from, plus the committed
 * views themselves.
 */
const SPEC_SOURCE_PATTERNS: RegExp[] = [
  /^db\/schema\.ts$/,
  /^modules\/[^/]+\/db\/schema\.ts$/,
  /(^|\/)app\/Models\//,
  /(^|\/)app\/Http\/Controllers\//,
  /(^|\/)app\/Http\/Resources\//,
  /^routes\//,
  /^modules\/[^/]+\/(routes|index)\.ts$/,
  /^resources\/js\/pages\//,
  /^docs\/spec\//,
]

/**
 * The tbls-style drift gate (RFC 0004): regenerate every spec view in
 * memory and fail when the committed `docs/spec/` files differ — the
 * committed spec cannot silently lie. Activates only when `docs/spec/`
 * exists, so apps that never ran `spec:generate` see zero results.
 */
export async function runSpecCheck(options: SpecCheckOptions): Promise<CheckResult[]> {
  const { cwd, routesFile, changedFiles } = options

  if (!(await directoryExists(resolve(cwd, SPEC_DIR)))) {
    return []
  }

  if (changedFiles && ![...changedFiles].some((file) => SPEC_SOURCE_PATTERNS.some((p) => p.test(file)))) {
    return []
  }

  const artifacts = await generateSpecArtifacts({ cwd, routesFile })
  const results: CheckResult[] = []

  for (const artifact of artifacts) {
    const specPath = `${SPEC_DIR}/${artifact.fileName}`
    const committed = await readIfExists(cwd, specPath)

    if (committed === null) {
      results.push(
        check(
          `spec-drift:${artifact.fileName}`,
          specPath,
          'fail',
          `${specPath} is missing.`,
          'Run: bunx guren spec:generate',
          specPath,
        ),
      )
      continue
    }

    const drifted = committed !== artifact.content
    results.push(
      check(
        `spec-drift:${artifact.fileName}`,
        specPath,
        drifted ? 'fail' : 'pass',
        drifted ? `${specPath} is out of date with the code.` : `${specPath} matches the code.`,
        drifted ? 'Run: bunx guren spec:generate' : undefined,
        specPath,
      ),
    )
  }

  return results
}
