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
import { compareVersions, isExactVersion, runCodemods, type CodemodResult } from './codemods'

const PACKAGE_JSON = 'package.json'
const GUREN_PACKAGE = /^(?:@guren\/|create-guren-app$)/u
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

/** `latest`, not `rc` — the `rc` tag still points at Guren's pre-1.0 candidates. */
export const DEFAULT_UPGRADE_TAG = 'latest'

/** The one tag pinned literally, so installs keep following it. */
export const CANARY_TAG = 'canary'

/** Kept in step with what `@guren/orm` depends on, not with each other. */
const DRIZZLE_PACKAGES = ['drizzle-orm', 'drizzle-kit'] as const

/** Fields that describe what gets installed, so a duplicate copy is possible. */
const DRIZZLE_ALIGNED_FIELDS = ['dependencies', 'devDependencies'] as const

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
  /** Override registry dependency-pin lookups (used in tests). */
  dependencyPinResolver?: (
    packageName: string,
    version: string,
    dependency: string,
  ) => Promise<string | null>
  /** Override registry version-existence lookups (used in tests). */
  versionExistsResolver?: (packageName: string, version: string) => Promise<boolean>
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
  /** True when `targetVersion` is a version the registry returned, not the tag name. */
  resolvedTarget: boolean
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
  // The dist-tags endpoint returns just the tag map. The full packument carries
  // every published version's metadata — 33 KB for @guren/cli against 61 B
  // here, and it grows with every release.
  const response = await fetch(`https://registry.npmjs.org/-/package/${packageName}/dist-tags`)
  if (!response.ok) {
    return null
  }
  const tags = (await response.json()) as Record<string, string>
  return tags[tag] ?? null
}

interface Packument {
  versions?: Record<string, { dependencies?: Record<string, string> }>
}

/**
 * The full package document, cached per package. Only worth its size for
 * reading a published version's own dependencies or checking a version exists;
 * tag lookups use the dist-tags endpoint above. `guren upgrade` is a one-shot
 * command, so nothing here outlives the process.
 */
const packumentCache = new Map<string, Promise<Packument | null>>()

function fetchPackument(packageName: string): Promise<Packument | null> {
  const cached = packumentCache.get(packageName)
  if (cached) {
    return cached
  }
  const pending = (async (): Promise<Packument | null> => {
    const response = await fetch(`https://registry.npmjs.org/${packageName}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    return response.ok ? ((await response.json()) as Packument) : null
  })().catch(() => null)
  packumentCache.set(packageName, pending)
  return pending
}

/** Whether a package has a given version published. */
async function resolveVersionExists(packageName: string, version: string): Promise<boolean> {
  const payload = await fetchPackument(packageName)
  return Boolean(payload?.versions?.[version])
}

/** Read what a published version of a package pins one of its dependencies to. */
async function resolveDependencyPin(
  packageName: string,
  version: string,
  dependency: string,
): Promise<string | null> {
  const payload = await fetchPackument(packageName)
  return payload?.versions?.[version]?.dependencies?.[dependency] ?? null
}

type VersionResolver = (packageName: string, tag: string) => Promise<string | null>
type DependencyPinResolver = (
  packageName: string,
  version: string,
  dependency: string,
) => Promise<string | null>
type VersionExistsResolver = (packageName: string, version: string) => Promise<boolean>

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
    // Cache the normalized result, never a rejected promise: replaying one to a
    // caller that does not catch took the whole command down when the registry
    // was unreachable.
    const pending = Promise.resolve()
      .then(() => resolver(packageName, tag))
      .catch(() => null)
    cache.set(key, pending)
    return pending
  }
}

/**
 * Align the app's `drizzle-orm` and `drizzle-kit` pins with the version
 * `@guren/orm` depends on.
 *
 * `@guren/orm` names an exact `drizzle-orm` version under `dependencies`, not a
 * range, so an app pinning a different one gets a second nested copy on install
 * — the app builds its table descriptors against one copy while the adapter
 * runs on the other. Aligning `@guren/*` alone is what leaves that behind.
 *
 * `drizzle-kit` has no upstream declaration to read: it is not a dependency of
 * `@guren/orm`, only of apps and templates. Matching it to `drizzle-orm` is the
 * repo's convention (the two ship as a pair), not a fact from the registry.
 */
async function alignDrizzlePins(
  manifest: PackageManifest,
  tag: string,
  versionResolver: VersionResolver,
  pinResolver: DependencyPinResolver,
  versionExistsResolver: VersionExistsResolver,
  updatedDependencies: UpgradedDependency[],
): Promise<void> {
  // Runtime fields only. A `peerDependencies` entry is a compatibility range a
  // library publishes, not an installed copy to dedupe — narrowing it to one
  // exact version would shrink what that library declares it works with.
  const fieldsWithDrizzle = DRIZZLE_ALIGNED_FIELDS.filter((field) =>
    DRIZZLE_PACKAGES.some((name) => manifest[field]?.[name]),
  )
  // Only meaningful for an app that uses the ORM: the pin being matched is the
  // one @guren/orm brings with it.
  const usesGurenOrm = MANIFEST_FIELDS.some((field) => manifest[field]?.['@guren/orm'])
  if (fieldsWithDrizzle.length === 0 || !usesGurenOrm) {
    return
  }

  const ormVersion = await versionResolver('@guren/orm', tag)
  if (!ormVersion) {
    return
  }

  const pin = await pinResolver('@guren/orm', ormVersion, 'drizzle-orm')
  if (!pin) {
    console.warn(
      `[guren upgrade] Could not read the drizzle-orm version @guren/orm@${ormVersion} depends on — leaving the drizzle pins alone.`,
    )
    return
  }

  // Deduping only works if the ORM names one exact version. A range would let
  // the app and the nested copy resolve differently, which is the situation
  // being fixed — and copying a range into `drizzle-kit` says nothing useful.
  if (!isExactVersion(pin)) {
    console.warn(
      `[guren upgrade] @guren/orm@${ormVersion} depends on drizzle-orm "${pin}", which is not a single exact version — leaving the drizzle pins alone.`,
    )
    return
  }

  for (const field of fieldsWithDrizzle) {
    const dependencies = manifest[field]
    if (!dependencies) {
      continue
    }
    for (const name of DRIZZLE_PACKAGES) {
      const current = dependencies[name]
      if (!current || current === pin) {
        continue
      }
      // `workspace:`, `file:`, `catalog:` and friends name a location on
      // purpose — usually a local drizzle build being developed against.
      // Replacing that with a registry release changes what the app runs.
      if (NON_REGISTRY_SPECIFIER.test(current)) {
        console.warn(
          `[guren upgrade] ${field}.${name} is "${current}", which names a location rather than a release — leaving it alone. Align it with drizzle-orm ${pin} yourself if you want the ORM's copy deduped.`,
        )
        continue
      }
      // drizzle-kit is a separate package on its own release line; it is not a
      // dependency of @guren/orm, so nothing guarantees the ORM's drizzle-orm
      // version was ever published for it. Writing one that does not exist
      // would break the next install.
      if (name !== 'drizzle-orm' && !(await versionExistsResolver(name, pin))) {
        console.warn(
          `[guren upgrade] ${name}@${pin} does not exist on npm — leaving ${field}.${name} at "${current}". Pick the ${name} release matching drizzle-orm ${pin} yourself.`,
        )
        continue
      }
      dependencies[name] = pin
      updatedDependencies.push({ field, name, previousVersion: current, nextVersion: pin })
    }
  }
}

async function updateManifestDependencies(
  cwd: string,
  dryRun = false,
  tag = DEFAULT_UPGRADE_TAG,
  versionResolver: VersionResolver = resolveDistTagVersion,
  pinResolver: DependencyPinResolver = resolveDependencyPin,
  versionExistsResolver: VersionExistsResolver = resolveVersionExists,
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
    if (tag === CANARY_TAG) {
      return CANARY_TAG
    }
    const version = await versionResolver(name, tag)
    return version ? `^${version}` : null
  }

  // Warm every distinct package concurrently first. The loop below then hits the
  // memo, so one round trip replaces one per package — and an unreachable
  // registry costs a single connect timeout instead of one for each.
  if (tag !== CANARY_TAG) {
    const names = new Set(
      MANIFEST_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})).filter((name) =>
        GUREN_PACKAGE.test(name),
      ),
    )
    await Promise.all([...names].map((name) => versionResolver(name, tag)))
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

  await alignDrizzlePins(manifest, tag, versionResolver, pinResolver, versionExistsResolver, updatedDependencies)

  if (!dryRun && updatedDependencies.length > 0) {
    await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  return {
    packageJsonPath,
    updatedDependencies,
  }
}

export async function checkVersionCompatibility(
  cwd: string,
  targetTag: string,
  versionResolver: VersionResolver = resolveDistTagVersion,
): Promise<VersionCompatibility> {
  const manifestPath = join(cwd, 'package.json')
  const raw = await readFile(manifestPath, 'utf-8').catch(() => null)
  if (!raw) {
    return {
      compatible: true,
      currentVersion: 'unknown',
      targetVersion: targetTag,
      resolvedTarget: false,
      downgrade: false,
      warnings: [],
    }
  }

  const manifest = JSON.parse(raw)
  const deps = { ...manifest.dependencies, ...manifest.devDependencies }

  // Anchor on the first @guren/* pin that names an exact release: a
  // `workspace:*` entry names a location and a partial `1.3` cannot be ordered.
  const reference = Object.entries(deps)
    .filter(([name]) => name.startsWith('@guren/'))
    .map(([name, specifier]) => ({ name, version: String(specifier).replace(/^[\^~]/, '') }))
    .find(({ version }) => isExactVersion(version))

  const currentVersion = reference?.version ?? 'unknown'
  const warnings: string[] = []

  // Check Bun version compatibility
  const bunVersion = process.versions?.bun
  if (bunVersion && compareVersions(bunVersion, '1.0.0') < 0) {
    warnings.push(`Bun ${bunVersion} may not be compatible. Recommend Bun 1.3.x or later.`)
  }

  // Resolve the tag so the report names a version: a tag left behind by an
  // older release line must not read as a clean upgrade. Only the anchor pin is
  // checked, and tags can resolve per-package, so this is a safety net over the
  // common case rather than a guarantee for every rewrite the updater makes.
  const resolved =
    reference && targetTag !== CANARY_TAG
      // The resolver passed in by upgradeCanary already normalizes failures;
      // this catch covers a direct call with a raw one.
      ? await versionResolver(reference.name, targetTag).catch(() => null)
      : null

  let downgrade = false
  if (reference && targetTag !== CANARY_TAG && !resolved) {
    warnings.push(
      `Could not resolve ${reference.name}@${targetTag} from the npm registry, so the target version is unknown.`,
    )
  } else if (resolved && compareVersions(resolved, currentVersion) < 0) {
    downgrade = true
    warnings.push(
      `Tag "${targetTag}" resolves ${reference?.name} to ${resolved}, which is older than the ${currentVersion} ` +
        `this app already pins. Continuing would downgrade it. ` +
        `Run with --tag ${DEFAULT_UPGRADE_TAG} for the current release.`,
    )
  }

  return {
    compatible: warnings.length === 0,
    currentVersion,
    targetVersion: resolved ?? targetTag,
    resolvedTarget: resolved !== null,
    downgrade,
    warnings,
  }
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

  const { packageJsonPath, updatedDependencies } = await updateManifestDependencies(cwd, Boolean(options.dryRun), tag, versionResolver, options.dependencyPinResolver, options.versionExistsResolver)
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

  // Codemod ranges are written against versions, so an unresolved tag name has
  // nothing to match and running them would silently select none.
  const codemodResults = versionCompatibility.resolvedTarget
    ? await runCodemods(
        cwd,
        versionCompatibility.currentVersion,
        versionCompatibility.targetVersion,
        { dryRun: options.dryRun },
      )
    : []

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
