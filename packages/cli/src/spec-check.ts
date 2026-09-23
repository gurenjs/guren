import { resolve } from 'node:path'
import { readIfExists, directoryExists } from './discovery'
import { generateSpecArtifacts, SPEC_VIEWS, type SpecViewDescriptor } from './spec-generate'
import { SPEC_DIR } from './spec-artifact'
import { check, commandFix, formatFixCommand, type CheckResult } from './check-result'
import { escapeRegExp } from './utils'

export interface SpecCheckOptions {
  cwd: string
  routesFile?: string
  /** Regenerate only the views whose sources changed. */
  changedFiles?: Set<string> | null
}

/**
 * The views whose sources intersect the changed set. Every view also depends on its own
 * committed file, and the screens view on a custom `--routes` entry when configured.
 */
function selectViews(
  changedFiles: Set<string> | null | undefined,
  routesFile: string | undefined,
): SpecViewDescriptor[] {
  if (!changedFiles) return SPEC_VIEWS
  const changed = [...changedFiles]

  return SPEC_VIEWS.filter((view) => {
    const sources = [
      ...view.sources.map((source) => source.pattern),
      new RegExp(`^${escapeRegExp(`${SPEC_DIR}/${view.fileName}`)}$`),
    ]
    if (view.fileName === 'screens.md' && routesFile) {
      sources.push(new RegExp(`^${escapeRegExp(routesFile)}$`))
    }
    return changed.some((file) => sources.some((pattern) => pattern.test(file)))
  })
}

/**
 * The tbls-style drift gate (RFC 0004): regenerate the affected spec views in memory and
 * fail when the committed `docs/spec/` files differ. Activates only when `docs/spec/`
 * exists, so apps that never ran `spec:generate` see zero results.
 */
export async function runSpecCheck(options: SpecCheckOptions): Promise<CheckResult[]> {
  const { cwd, routesFile, changedFiles } = options

  if (!(await directoryExists(resolve(cwd, SPEC_DIR)))) {
    return []
  }

  const views = selectViews(changedFiles, routesFile)
  if (views.length === 0) return []

  const artifacts = await generateSpecArtifacts({ cwd, routesFile }, views)
  // The views were derived from `routesFile`, so the regeneration has to read the same one.
  const fix = routesFile === undefined ? commandFix('spec:generate') : commandFix('spec:generate', '--routes', routesFile)
  const results: CheckResult[] = []

  for (const artifact of artifacts) {
    const specPath = `${SPEC_DIR}/${artifact.fileName}`
    const key = `spec-drift:${artifact.fileName}`

    if (artifact.degraded) {
      // A degraded regeneration cannot be byte-compared: the drift it reports could only
      // be "fixed" by destroying the committed view.
      results.push(
        check(key, specPath, 'warn', `Skipped: ${artifact.degraded}`, 'Fix the underlying error, then run: bunx guren check --spec', specPath),
      )
      continue
    }

    const committed = await readIfExists(cwd, specPath)
    if (committed === artifact.content) {
      results.push(check(key, specPath, 'pass', `${specPath} matches the code.`, undefined, specPath))
      continue
    }
    const message = committed === null ? `${specPath} is missing.` : `${specPath} is out of date with the code.`
    results.push({
      ...check(key, specPath, 'fail', message, `Run: ${formatFixCommand(fix)}`, specPath),
      fix,
    })
  }

  return results
}
