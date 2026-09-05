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

/**
 * A member call, never a mention. `@guren/cli` ships this very scanner and
 * `@guren/server` its JSDoc, so a package that only names the method — in a
 * string, a comment, a type — is not a declarer. Matches the shapes that
 * survive a bundle (Guren forbids identifier mangling): dotted, optional-call,
 * and computed access.
 */
const DECLARE_CALL_PATTERN =
  /(?:\.\s*declareCookielessAuthPath|\[\s*['"`]declareCookielessAuthPath['"`]\s*\])\s*(?:\?\.)?\s*\(/

/** For the messages, which must not themselves be a call the scan would match. */
const DECLARE_CALL = 'declareCookielessAuthPath'

/**
 * npm reserves the scope, so a package published under it is this repo's, whose
 * own declaration is reviewed here. Read from the installed manifest rather
 * than the dependency key, which an `npm:` alias controls.
 */
const FIRST_PARTY_SCOPE = '@guren/'

const SCANNED_EXTENSIONS = ['.js', '.mjs', '.cjs']

/**
 * Bounds the walk of a package that ships far more than a plugin does
 * (`@guren/plugin-mcp` ships 4 files). Hitting it truncates the scan, which is
 * reported rather than answered as "declares nothing".
 */
const MAX_FILES_PER_PACKAGE = 400

export interface CsrfExemptionScan {
  /** 'partial' when a candidate package was unreadable or only partly walked. */
  status: 'complete' | 'partial'
  packagesScanned: number
  /** Installed packages that declare one, first-party included. */
  declaredBy: string[]
}

interface PackageScan {
  packageName: string
  declares: boolean
  /** The file cap cut the walk short, so the coverage is not what it looks like. */
  truncated: boolean
}

interface PackageManifest {
  name?: unknown
  gurenPlugin?: unknown
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/**
 * A package that could plausibly hold the call: it declares a `gurenPlugin`
 * manifest, or depends on the package the method lives on. Reading every
 * declared dependency instead would walk React and Vite for one string.
 */
function isGurenFacing(manifest: PackageManifest): boolean {
  if (manifest.gurenPlugin && typeof manifest.gurenPlugin === 'object') return true

  const related = { ...manifest.dependencies, ...manifest.peerDependencies }
  return '@guren/core' in related || '@guren/server' in related
}

/** Files the package ships, nested `node_modules` excluded: a hoisted copy is its own dependency. */
async function collectPackageFiles(packageDir: string): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = []
  const queue = [packageDir]

  while (queue.length > 0) {
    const dir = queue.shift()!

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      const full = join(dir, entry.name)

      if (entry.isDirectory()) {
        queue.push(full)
      } else if (SCANNED_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        // Refusing a file is what truncation means — a package holding exactly
        // the cap was read in full and must not report partial coverage.
        if (files.length === MAX_FILES_PER_PACKAGE) return { files, truncated: true }
        files.push(full)
      }
    }
  }

  return { files, truncated: false }
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

  // A manifest that will not parse leaves the package unclassified, which is
  // an unreadable package rather than one known to be irrelevant.
  const manifest = JSON.parse(manifestRaw) as PackageManifest
  if (!isGurenFacing(manifest)) return null

  const { files, truncated } = await collectPackageFiles(packageDir)
  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')))

  return {
    // The published name, so an `npm:` alias cannot borrow the trusted scope.
    packageName: typeof manifest.name === 'string' ? manifest.name : packageName,
    declares: sources.some((source) => DECLARE_CALL_PATTERN.test(source)),
    truncated,
  }
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
      suggestion: 'Reinstall dependencies and re-run: bunx guren audit',
    })
  }

  const truncatedPackages = scanned.filter((result) => result.truncated)
  for (const cut of truncatedPackages) {
    findings.push({
      key: `csrf-exemption:truncated:${cut.packageName}`,
      title: `${cut.packageName} partly scanned`,
      status: 'warn',
      message:
        `${cut.packageName} ships more than ${MAX_FILES_PER_PACKAGE} JavaScript files, so the scan `
        + 'stopped there and did not see every file it ships.',
      suggestion: `Search the package by hand for a call to ${DECLARE_CALL}.`,
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
        `${thirdParty.join(', ')} calls ${DECLARE_CALL} to exempt a path from CSRF verification. `
        + "The path is chosen at boot from the plugin's configuration, so it cannot be reported here.",
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
    status: unreadable.length > 0 || truncatedPackages.length > 0 ? 'partial' : 'complete',
    packagesScanned: scanned.length,
    declaredBy: declaring,
  }
}
