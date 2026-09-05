import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readDeclaredDependencyNames } from './plugin-manifest'
import type { AuditFinding } from './audit'

/**
 * Inventory of `declareCookielessAuthPath()` callers among an app's installed
 * packages, for `guren audit`. That call exempts a path from CSRF verification,
 * and a plugin making it is invisible to the source scan, which never reads
 * node_modules. Names packages, never paths: the path is an argument computed
 * at boot from the plugin's configuration, so no static read can know it.
 */

/** The call as it survives a bundle: Guren forbids identifier mangling. */
const DECLARE_CALL = 'declareCookielessAuthPath'

/**
 * npm reserves the scope, so a package under it is this repo's, whose own
 * declaration is reviewed here. Any other publisher's is the one a human
 * has to look at.
 */
const FIRST_PARTY_SCOPE = '@guren/'

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs']

/**
 * Bounds the walk of a dependency that is not a plugin at all. Reached only by
 * a package whose manifest points at Guren, so the cap is far above a real one
 * (`@guren/plugin-mcp` ships 4 files).
 */
const MAX_FILES_PER_PACKAGE = 400

export interface CsrfExemptionScan {
  /** 'partial' when a candidate package could not be read — never a pass. */
  status: 'complete' | 'partial'
  packagesScanned: number
  /** Installed packages that declare one, first-party included. */
  declaredBy: string[]
}

interface PackageScan {
  packageName: string
  declares: boolean
}

/**
 * A dependency that could plausibly hold the call: it declares a `gurenPlugin`
 * manifest, or depends on the package the method lives on. Reading every
 * declared dependency instead would walk React and Vite for one string.
 */
async function isGurenFacing(manifestRaw: string): Promise<boolean> {
  let parsed: {
    gurenPlugin?: unknown
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  try {
    parsed = JSON.parse(manifestRaw)
  } catch {
    return false
  }

  if (parsed.gurenPlugin && typeof parsed.gurenPlugin === 'object') return true

  const related = { ...parsed.dependencies, ...parsed.peerDependencies }
  return '@guren/core' in related || '@guren/server' in related
}

/** Files the package ships, nested `node_modules` excluded: a hoisted copy is its own dependency. */
async function collectPackageFiles(packageDir: string): Promise<string[]> {
  const files: string[] = []
  const queue = [packageDir]

  while (queue.length > 0 && files.length < MAX_FILES_PER_PACKAGE) {
    const dir = queue.shift()!
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(full)
    }
  }

  return files
}

async function scanPackage(cwd: string, packageName: string): Promise<PackageScan | null> {
  const packageDir = resolve(cwd, 'node_modules', packageName)

  let manifestRaw: string
  try {
    manifestRaw = await readFile(join(packageDir, 'package.json'), 'utf8')
  } catch (error) {
    // Not installed is not a finding: the app declares it, `bun install` has
    // not run yet or the dependency is optional. Anything else is unreadable.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }

  if (!(await isGurenFacing(manifestRaw))) return null

  const files = await collectPackageFiles(packageDir)
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))

  return { packageName, declares: sources.some((source) => source.includes(DECLARE_CALL)) }
}

const REVIEW_SUGGESTION =
  'Confirm the endpoint each package mounts resolves its principal without ever reading a session '
  + 'cookie — CSRF verification is off for that path. Its path comes from the plugin\'s own '
  + 'configuration, so read the plugin\'s docs rather than guessing it.'

/**
 * Appends the inventory to `findings`. A package that is installed but
 * unreadable becomes its own warning: reporting "no exemptions" for a
 * directory that could not be opened would be the one answer worse than none.
 */
export async function auditCsrfExemptions(
  cwd: string,
  findings: AuditFinding[],
): Promise<CsrfExemptionScan> {
  const dependencies = await readDeclaredDependencyNames(cwd)

  const results = await Promise.all(
    dependencies.map(async (packageName) => {
      try {
        return await scanPackage(cwd, packageName)
      } catch (error) {
        return { packageName, error: error instanceof Error ? error.message : String(error) }
      }
    }),
  )

  const unreadable = results.filter(
    (result): result is { packageName: string; error: string } =>
      result !== null && 'error' in result,
  )
  const scanned = results.filter((result): result is PackageScan =>
    result !== null && 'declares' in result,
  )

  for (const failure of unreadable) {
    findings.push({
      key: `csrf-exemption:unreadable:${failure.packageName}`,
      title: `${failure.packageName} unreadable`,
      status: 'warn',
      message:
        `${failure.packageName} could not be read, so it was not checked for a CSRF exemption `
        + `(${failure.error}).`,
      suggestion: `Reinstall dependencies and re-run: bunx guren audit`,
    })
  }

  const declaring = scanned.filter((result) => result.declares).map((result) => result.packageName)
  const thirdParty = declaring.filter((name) => !name.startsWith(FIRST_PARTY_SCOPE))

  if (thirdParty.length > 0) {
    findings.push({
      key: 'csrf-exemption:plugin',
      title: 'Plugin CSRF exemptions',
      status: 'warn',
      message:
        `${thirdParty.join(', ')} exempts a path from CSRF verification via `
        + `${DECLARE_CALL}(). The path is chosen at boot from the plugin's configuration, so it `
        + 'cannot be reported here.',
      suggestion: REVIEW_SUGGESTION,
    })
  } else {
    findings.push({
      key: 'csrf-exemption:plugin',
      title: 'Plugin CSRF exemptions',
      status: 'pass',
      message:
        declaring.length > 0
          ? `Declared only by first-party packages (${declaring.join(', ')}), across `
            + `${scanned.length} Guren-facing package(s).`
          : `No CSRF exemption declared across ${scanned.length} Guren-facing package(s).`,
    })
  }

  return {
    status: unreadable.length > 0 ? 'partial' : 'complete',
    packagesScanned: scanned.length,
    declaredBy: declaring,
  }
}
