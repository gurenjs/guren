import { readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DOCTOR_RECOMMENDED_COMMANDS,
  getDoctorRuleEvaluations,
  type DoctorAutofix,
  type DoctorCheck,
} from './doctor'
import { checkDeprecations, type DeprecationWarning } from './deprecations'
import { runCommand } from './utils'
import { compareVersions, runCodemods, type CodemodResult } from './codemods'

const PACKAGE_JSON = 'package.json'
const GUREN_PACKAGE = /^(?:@guren\/|create-guren-app$)/u
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/**
 * npm dist-tag `guren upgrade` targets when none is given.
 *
 * `latest`, not `rc`: the `rc` tag still points at the pre-1.0 candidates it
 * was cut for, so defaulting to it walks a released app backwards across the
 * 1.0 boundary. The duplicate-`@guren/orm` runtime warning names this command
 * as its remedy, which is exactly when a silent downgrade would hurt most.
 */
export const DEFAULT_UPGRADE_TAG = 'latest'

/** Version specifiers that name a location instead of a release. */
const NON_REGISTRY_SPECIFIER = /^(?:workspace|catalog|link|file|npm|git|github|portal):/u

type ManifestField = (typeof MANIFEST_FIELDS)[number]

export interface UpgradeCanaryOptions {
  cwd?: string
  install?: boolean
  dryRun?: boolean
  noAutofix?: boolean
  checkOnly?: boolean
  installRunner?: (cwd: string) => Promise<void>
  /**
   * npm dist-tag to upgrade to (default: {@link DEFAULT_UPGRADE_TAG}).
   * 'canary' pins the literal tag so installs keep floating; any other tag is
   * resolved to a concrete version and written as ^version.
   */
  tag?: string
  /** Override registry version lookups (used in tests). */
  versionResolver?: (packageName: string, tag: string) => Promise<string | null>
}

export interface UpgradedDependency {
  field: ManifestField
  name: string
  previousVersion: string
  nextVersion: string
}

export interface UpgradeAutofixResult {
  key: string
  title: string
  summary: string
  applied: boolean
}

export interface UpgradeCanaryResult {
  packageJsonPath: string
  updatedDependencies: UpgradedDependency[]
  autofixes: UpgradeAutofixResult[]
  warnings: DoctorCheck[]
  manualSteps: string[]
  recommendedCommands: string[]
  versionCompatibility?: VersionCompatibility
  deprecationWarnings: DeprecationWarning[]
  codemodResults: CodemodResult[]
}

export interface VersionCompatibility {
  compatible: boolean
  currentVersion: string
  /** Concrete version the tag resolved to, or the tag when it could not be resolved. */
  targetVersion: string
  /** True when the resolved target is older than what the app already pins. */
  downgrade: boolean
  warnings: string[]
}

type PackageManifest = Partial<Record<ManifestField, Record<string, string>>> & {
  name?: string
  version?: string
}

async function findNestedGurenCopies(cwd: string): Promise<string[]> {
  const gurenRoot = resolve(cwd, 'node_modules', '@guren')
  if (!existsSync(gurenRoot)) {
    return []
  }

  const nested: string[] = []
  const entries = await readdir(gurenRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const nestedGuren = resolve(gurenRoot, entry.name, 'node_modules', '@guren')
    if (!existsSync(nestedGuren)) {
      continue
    }
    const inner = await readdir(nestedGuren).catch(() => [])
    for (const innerName of inner) {
      nested.push(`@guren/${entry.name} -> @guren/${innerName}`)
    }
  }

  return nested
}

async function runBunInstall(cwd: string): Promise<void> {
  await runCommand(process.execPath || 'bun', ['install'], { cwd })
}

async function resolveDistTagVersion(packageName: string, tag: string): Promise<string | null> {
  const response = await fetch(`https://registry.npmjs.org/${packageName}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  })
  if (!response.ok) {
    return null
  }
  const payload = (await response.json()) as { 'dist-tags'?: Record<string, string> }
  return payload['dist-tags']?.[tag] ?? null
}

type VersionResolver = (packageName: string, tag: string) => Promise<string | null>

/**
 * Resolve each package once. The tag is looked up both to report the target
 * version and to rewrite the manifest, and a package appears in more than one
 * manifest field in real apps.
 */
function memoizeResolver(resolver: VersionResolver): VersionResolver {
  const cache = new Map<string, Promise<string | null>>()
  return (packageName, tag) => {
    const key = `${packageName}@${tag}`
    const cached = cache.get(key)
    if (cached) {
      return cached
    }
    const pending = resolver(packageName, tag)
    cache.set(key, pending)
    return pending
  }
}

async function updateManifestDependencies(
  cwd: string,
  dryRun = false,
  tag = DEFAULT_UPGRADE_TAG,
  versionResolver: VersionResolver = resolveDistTagVersion,
): Promise<{
  packageJsonPath: string
  updatedDependencies: UpgradedDependency[]
}> {
  const packageJsonPath = resolve(cwd, PACKAGE_JSON)
  const raw = await readFile(packageJsonPath, 'utf8')
  const manifest = JSON.parse(raw) as PackageManifest
  const updatedDependencies: UpgradedDependency[] = []

  // 'canary' keeps the floating dist-tag pin; other tags resolve to ^version
  // so every @guren/* package lands on one coherent release.
  const resolveTarget = async (name: string): Promise<string | null> => {
    if (tag === 'canary') {
      return 'canary'
    }
    const version = await versionResolver(name, tag)
    return version ? `^${version}` : null
  }

  for (const field of MANIFEST_FIELDS) {
    const dependencies = manifest[field]
    if (!dependencies) {
      continue
    }

    for (const [name, version] of Object.entries(dependencies)) {
      if (!GUREN_PACKAGE.test(name)) {
        continue
      }

      const nextVersion = await resolveTarget(name)
      if (nextVersion === null) {
        console.warn(`[guren upgrade] Could not resolve ${name}@${tag} from the npm registry — leaving it at ${version}.`)
        continue
      }

      if (version === nextVersion) {
        continue
      }

      dependencies[name] = nextVersion
      updatedDependencies.push({
        field,
        name,
        previousVersion: version,
        nextVersion,
      })
    }
  }

  if (!dryRun && updatedDependencies.length > 0) {
    await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  return {
    packageJsonPath,
    updatedDependencies,
  }
}

/** True when the specifier names a release we can order against another one. */
function isComparableVersion(specifier: string): boolean {
  return !NON_REGISTRY_SPECIFIER.test(specifier) && !Number.isNaN(compareVersions(specifier, specifier))
}

export async function checkVersionCompatibility(
  cwd: string,
  targetTag: string,
  versionResolver: VersionResolver = resolveDistTagVersion,
): Promise<VersionCompatibility> {
  const manifestPath = join(cwd, 'package.json')
  const raw = await readFile(manifestPath, 'utf-8').catch(() => null)
  if (!raw) {
    return { compatible: true, currentVersion: 'unknown', targetVersion: targetTag, downgrade: false, warnings: [] }
  }

  const manifest = JSON.parse(raw)
  const deps = { ...manifest.dependencies, ...manifest.devDependencies }

  // Reference the first @guren/* package whose pin names a release. A
  // `workspace:*` or `catalog:` entry names a location, so it cannot anchor
  // the comparison below.
  const reference = Object.entries(deps)
    .filter(([name]) => name.startsWith('@guren/'))
    .map(([name, specifier]) => [name, String(specifier).replace(/^[\^~]/, '')] as const)
    .find(([, version]) => isComparableVersion(version))

  const currentVersion = reference?.[1] ?? 'unknown'
  const warnings: string[] = []

  // Check Bun version compatibility
  const bunVersion = process.versions?.bun
  if (bunVersion && compareVersions(bunVersion, '1.0.0') < 0) {
    warnings.push(`Bun ${bunVersion} may not be compatible. Recommend Bun 1.3.x or later.`)
  }

  // Report the version the tag points at rather than the tag itself, so that
  // a tag left behind by an older release line cannot walk an app backwards
  // while the report still reads as a clean upgrade.
  let targetVersion = targetTag
  let downgrade = false
  if (reference && targetTag !== 'canary') {
    const resolved = await versionResolver(reference[0], targetTag).catch(() => null)
    if (resolved) {
      targetVersion = resolved
      if (compareVersions(resolved, currentVersion) < 0) {
        downgrade = true
        warnings.push(
          `Tag "${targetTag}" resolves ${reference[0]} to ${resolved}, which is older than the ${currentVersion} ` +
            `this app already pins. Continuing would downgrade it. ` +
            `Run with --tag ${DEFAULT_UPGRADE_TAG} for the current release.`,
        )
      }
    }
  }

  return { compatible: warnings.length === 0, currentVersion, targetVersion, downgrade, warnings }
}

function collectManualSteps(checks: DoctorCheck[]): string[] {
  return checks
    .map((check) => check.manualFix ?? check.fix)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export async function upgradeCanary(options: UpgradeCanaryOptions = {}): Promise<UpgradeCanaryResult> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const tag = options.tag ?? DEFAULT_UPGRADE_TAG
  const manualStepsExtra: string[] = []
  const versionResolver = memoizeResolver(options.versionResolver ?? resolveDistTagVersion)

  // Run version compatibility and deprecation checks
  const versionCompatibility = await checkVersionCompatibility(cwd, tag, versionResolver)
  const deprecationWarnings = await checkDeprecations(cwd)

  // If check-only mode, return early with just the checks
  if (options.checkOnly) {
    const packageJsonPath = resolve(cwd, PACKAGE_JSON)
    return {
      packageJsonPath,
      updatedDependencies: [],
      autofixes: [],
      warnings: [],
      manualSteps: [],
      recommendedCommands: [],
      versionCompatibility,
      deprecationWarnings,
      codemodResults: [],
    }
  }

  const { packageJsonPath, updatedDependencies } = await updateManifestDependencies(cwd, Boolean(options.dryRun), tag, versionResolver)
  const { evaluations } = await getDoctorRuleEvaluations({ cwd })

  const candidateAutofixes = evaluations
    .filter((evaluation): evaluation is { check: DoctorCheck; autofix: DoctorAutofix } =>
      evaluation.check.status !== 'pass' && Boolean(evaluation.autofix),
    )

  const autofixes: UpgradeAutofixResult[] = []
  if (!options.noAutofix) {
    for (const evaluation of candidateAutofixes) {
      if (!options.dryRun) {
        await evaluation.autofix.apply(cwd)
      }

      autofixes.push({
        key: evaluation.autofix.key,
        title: evaluation.autofix.title,
        summary: evaluation.autofix.summary,
        applied: !options.dryRun,
      })
    }
  }

  const warningChecks = evaluations
    .map((evaluation) => evaluation.check)
    .filter((check) => {
      if (check.status === 'pass') {
        return false
      }
      if (check.canAutofix && !options.noAutofix && !options.dryRun) {
        return false
      }
      return true
    })

  // Run codemods for the version transition. The resolved version is what the
  // codemod ranges are written against; the tag name never matched any of them.
  const codemodResults = await runCodemods(
    cwd,
    versionCompatibility.currentVersion,
    versionCompatibility.targetVersion,
    { dryRun: options.dryRun },
  )

  if (!options.dryRun && options.install && updatedDependencies.length > 0) {
    const installRunner = options.installRunner ?? runBunInstall
    await installRunner(cwd)
  }

  // Nested @guren copies survive plain `bun install` because the lockfile
  // keeps the old resolution. Two loaded copies of @guren/orm means adapter
  // state is split and database access fails, so surface it loudly.
  const nestedCopies = await findNestedGurenCopies(cwd)
  if (nestedCopies.length > 0) {
    manualStepsExtra.push(
      `Duplicate @guren copies detected (${nestedCopies.join(', ')}). ` +
        'Run `rm -rf node_modules bun.lock && bun install` to dedupe them.',
    )
  }

  return {
    packageJsonPath,
    updatedDependencies,
    autofixes,
    warnings: warningChecks,
    manualSteps: [...collectManualSteps(warningChecks), ...manualStepsExtra],
    recommendedCommands: [...DOCTOR_RECOMMENDED_COMMANDS],
    versionCompatibility,
    deprecationWarnings,
    codemodResults,
  }
}
