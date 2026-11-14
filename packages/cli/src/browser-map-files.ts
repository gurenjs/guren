/**
 * `guren browser:map` (RFC 0033 §2): reads the graph and the approved plans, renders every
 * document, and writes only when every document can be rewritten safely. A file with no feature
 * any more is reported and kept, since it holds author text. Once `guren add browser-tests` has
 * written its config, the specs under `tests/browser/generated/` are kept here too (§6): a
 * generated spec nothing produces any more is removed, since no author text lives in one. The
 * behaviour specs (§13.5) are kept the same way, for an app that declares the runner and has its config.
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { loadApplicationGraph } from './application-graph-load'
import {
  BROWSER_MAP_DIR, BROWSER_MAP_INDEX, buildBrowserMap, renderFeatureDoc, renderIndexDoc,
  type ApprovedPlanInput, type BrowserMap,
} from './browser-map'
import {
  BEHAVIOUR_PACKAGES, BEHAVIOURS_CONFIG, BEHAVIOURS_GIVEN_FILE, BEHAVIOURS_SETUP, buildBehaviourSpecs, GENERATED_BEHAVIOURS_DIR,
} from './browser-behaviour-specs'
import {
  A11Y_OPTIONS_FILE, A11Y_SPEC_FILE, AXE_PACKAGE, BROWSER_TESTS_CONFIG, BROWSER_TESTS_SETUP, buildA11ySpec, buildPlanSpecs, buildSmokeSpec,
  GENERATED_HEADER, GENERATED_SPECS_DIR, SMOKE_SPEC_FILE, type SpecOptions,
} from './browser-specs'
import { CliError } from './cli-error'
import { compareStrings } from './spec-artifact'
import { appDependsOn, relativeUnreadableDirs, toPosixRelative } from './discovery'
import { discoverPlanFiles } from './plan-check'
import { writeFileAtomic } from './plan/beside'
import { readApprovedPlan } from './plan/open-plan'
import { pathExists } from './utils'

interface BrowserMapRun {
  map: BrowserMap
  /** App-relative paths whose content a run writes differently from what is on disk. */
  changed: string[]
  orphans: string[]
  /** Generated specs nothing produces any more; a run deletes them. */
  removed: string[]
  /** Why the generated specs were left as they are this run. */
  specsHeld?: string
  /** Why the generated specs this run writes leave out the accessibility spec (RFC 0033 §12.2). */
  accessibilityOff?: string
  /** Why no behaviour spec is written, for an app that shows a sign of having asked for them (RFC 0033 §13.5). */
  behavioursOff?: string
  /** Input keys a behaviour test sets that its view's form does not label, as `plan: id: key`. */
  unlabelledInputs?: string[]
}

/**
 * Plans approved at their current hash, closed or not, by `readApprovedPlan()`; a draft or an
 * unapproved plan is skipped. Reasons are app-relative, since the index that prints them is committed.
 */
export async function approvedPlans(cwd: string): Promise<{ plans: ApprovedPlanInput[]; unreadable: BrowserMap['unreadablePlans'] }> {
  const discovery = await discoverPlanFiles(cwd)
  const unreadable: BrowserMap['unreadablePlans'] = relativeUnreadableDirs(cwd, discovery.unreadable).map(({ dir, reason }) => ({ plan: dir, reason }))
  const readings = await Promise.all(discovery.files.map((path) => readApprovedPlan(cwd, path, 'it is not mapped')))
  const plans: ApprovedPlanInput[] = []
  readings.forEach((reading, index) => {
    if (reading.kind === 'approved') plans.push({ file: reading.plan.file, plan: reading.plan.plan })
    else if (reading.kind !== 'skipped') {
      unreadable.push({ plan: toPosixRelative(cwd, discovery.files[index]!), reason: reading.reason.replaceAll(`${cwd}${sep}`, '') })
    }
  })
  unreadable.sort((a, b) => compareStrings(a.plan, b.plan) || compareStrings(a.reason, b.reason))
  return { plans, unreadable }
}

/** App-relative file → contents for each `suffix` file directly in `dir`; none when the directory is absent. */
async function readExisting(cwd: string, dir: string, suffix: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  let names: string[]
  try {
    names = await readdir(join(cwd, dir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw new CliError(`${dir} could not be read: ${(error as Error).message}`)
  }
  // Without case: on a case-insensitive filesystem `posts.E2E.ts` is the file a run would write as `posts.e2e.ts`.
  for (const name of names.filter((entry) => entry.toLowerCase().endsWith(suffix)).sort()) {
    const file = `${dir}/${name}`
    files.set(file, await readFile(join(cwd, file), 'utf8'))
  }
  return files
}

/** The map with the plans it was built from, so the behaviour specs read the same plans the map placed. */
async function loadMapInputs(cwd: string): Promise<{ map: BrowserMap; plans: ApprovedPlanInput[] }> {
  const [graph, { plans, unreadable }] = await Promise.all([loadApplicationGraph({ cwd, introspect: true }), approvedPlans(cwd)])
  return { map: buildBrowserMap(graph, plans, unreadable), plans }
}

/** The map as `browser:map`, `add browser-tests` and the generated specs read it: the introspected graph and the approved plans. */
export async function loadBrowserMap(cwd: string): Promise<BrowserMap> {
  return (await loadMapInputs(cwd)).map
}

interface GeneratedSpecs {
  outputs: Map<string, string>
  onDisk: Map<string, string>
  held?: string
  accessibilityOff?: string
  behavioursOff?: string
  unlabelledInputs?: string[]
}

/**
 * Why no behaviour spec is written, on positive evidence only: both packages in the manifest, the
 * runner's config, and the given file every spec imports. `asked` is whether the app shows any of
 * them, so an app that never opted in is told nothing.
 */
async function behavioursOff(cwd: string): Promise<{ off?: string; asked: boolean }> {
  const [declared, config, given] = await Promise.all([
    Promise.all(BEHAVIOUR_PACKAGES.map((name) => appDependsOn(cwd, name))),
    pathExists(join(cwd, BEHAVIOURS_CONFIG)),
    pathExists(join(cwd, BEHAVIOURS_GIVEN_FILE)),
  ])
  // `e2e` alone is no sign: an app may run the runner for a suite of its own.
  const asked = config || given || declared[BEHAVIOUR_PACKAGES.indexOf('@e2e-dev/web')] === true
  if (declared.includes(null)) return { off: 'package.json is missing or does not parse', asked }
  const missing = BEHAVIOUR_PACKAGES.filter((_, index) => !declared[index])
  if (missing.length > 0) return { off: `${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not in package.json`, asked }
  const absent = [...(config ? [] : [BEHAVIOURS_CONFIG]), ...(given ? [] : [BEHAVIOURS_GIVEN_FILE])]
  return absent.length > 0 ? { off: `${absent.join(' and ')} ${absent.length > 1 ? 'do' : 'does'} not exist`, asked } : { asked }
}

/** Positive evidence only: the package in the manifest and the author's options file beside the specs. */
async function accessibilityOff(cwd: string): Promise<string | undefined> {
  const declared = await appDependsOn(cwd, AXE_PACKAGE)
  if (declared === null) return 'package.json is missing or does not parse'
  if (!declared) return `${AXE_PACKAGE} is not in package.json`
  if (!(await pathExists(join(cwd, A11Y_OPTIONS_FILE)))) return `${A11Y_OPTIONS_FILE} does not exist`
  return undefined
}

const HELD = 'the browser map is incomplete, a plan could not be read, or the plans are not the ones the map was built from'

/**
 * The generated specs a run writes, and the specs on disk beside them. The Playwright specs: none
 * until the browser-tests config exists, or as `planned` says when `add browser-tests` asks before
 * writing that config. The behaviour specs: on `behavioursOff()`'s evidence, whatever that config.
 */
async function generatedSpecs(
  cwd: string,
  map: BrowserMap,
  planned: SpecOptions | undefined,
  plans: readonly ApprovedPlanInput[] | undefined,
): Promise<GeneratedSpecs> {
  const playwright = planned !== undefined || await pathExists(join(cwd, BROWSER_TESTS_CONFIG))
  const [behaviours, behavioursOnDisk] = await Promise.all([behavioursOff(cwd), readExisting(cwd, GENERATED_BEHAVIOURS_DIR, '.e2e.ts')])
  const leftOnDisk = [...behavioursOnDisk.values()].some((content) => content.startsWith(GENERATED_HEADER))
  const behavioursNoted = behaviours.off !== undefined && (behaviours.asked || leftOnDisk)
  if (!playwright && behaviours.off !== undefined && !behavioursNoted) return { outputs: new Map(), onDisk: new Map() }
  // A partial map would regenerate the specs as fixme only, or delete an unread plan's: one failed read must not empty the suite.
  if (!map.complete || map.unreadablePlans.length > 0) return { outputs: new Map(), onDisk: new Map(), held: HELD }
  const discovery = await discoverPlanFiles(cwd)
  const sharedSlugs = new Map([...discovery.sharedSlugs].map(([slug, files]) => [slug, files.map((file) => toPosixRelative(cwd, file))]))
  const outputs = new Map<string, string>()
  const onDisk = new Map(behavioursOnDisk)

  let off: string | undefined
  if (playwright) {
    off = planned ? (planned.accessibility ? undefined : 'not requested') : await accessibilityOff(cwd)
    const options = planned ?? { signIn: await pathExists(join(cwd, BROWSER_TESTS_SETUP)) }
    outputs.set(SMOKE_SPEC_FILE, buildSmokeSpec(map, options))
    if (!off) outputs.set(A11Y_SPEC_FILE, buildA11ySpec(map, options))
    for (const entry of buildPlanSpecs(map, options, sharedSlugs)) outputs.set(entry.path, entry.contents)
    for (const dir of [GENERATED_SPECS_DIR, `${GENERATED_SPECS_DIR}/plans`]) {
      for (const [file, content] of await readExisting(cwd, dir, '.browser.ts')) onDisk.set(file, content)
    }
  }

  let unlabelled: string[] = []
  if (behaviours.off === undefined) {
    // A caller that passed its own map without its plans has them read here. Either way they have to be
    // the plans the map placed: with others, a spec would be written or removed for a plan the map never read.
    const read = plans ? { plans, unreadable: [] } : await approvedPlans(cwd)
    const files = read.plans.map((entry) => entry.file).sort(compareStrings)
    if (read.unreadable.length > 0 || files.join('\0') !== map.plans.join('\0')) return { outputs: new Map(), onDisk: new Map(), held: HELD }
    const written = buildBehaviourSpecs(map, read.plans, { signIn: await pathExists(join(cwd, BEHAVIOURS_SETUP)) }, sharedSlugs)
    for (const entry of written.files) outputs.set(entry.path, entry.contents)
    unlabelled = written.unlabelled
  }
  return {
    outputs, onDisk,
    ...(off ? { accessibilityOff: off } : {}),
    ...(behavioursNoted ? { behavioursOff: behaviours.off } : {}),
    ...(unlabelled.length > 0 ? { unlabelledInputs: unlabelled } : {}),
  }
}

/** Every document as a run would leave it; refuses, writing nothing, when any document's markers are unsafe. */
export async function runBrowserMap(options: { cwd: string; write: boolean; map?: BrowserMap; plans?: readonly ApprovedPlanInput[]; specs?: SpecOptions }): Promise<BrowserMapRun> {
  const cwd = resolve(options.cwd)
  const [loaded, existing] = await Promise.all([
    options.map ? { map: options.map, plans: options.plans } : loadMapInputs(cwd),
    readExisting(cwd, BROWSER_MAP_DIR, '.md'),
  ])
  const { map } = loaded

  // Compared without case: on a case-insensitive filesystem `readme.md` is the index.
  const claimed = new Set([BROWSER_MAP_INDEX.toLowerCase()])
  const featureFiles = new Set<string>()
  for (const feature of map.features) {
    if (claimed.has(feature.file.toLowerCase())) throw new CliError(`The feature ${feature.name} would write ${feature.file}, which another feature or the index already uses; rename its page directory.`)
    claimed.add(feature.file.toLowerCase())
    featureFiles.add(feature.file)
  }
  const orphans = [...existing.keys()].filter((file) => file !== BROWSER_MAP_INDEX && !featureFiles.has(file))

  const outputs = new Map<string, string>()
  const problems: string[] = []
  const add = (file: string, result: { content: string } | { problems: string[] }): void => {
    if ('problems' in result) problems.push(...result.problems.map((problem) => `${file}: ${problem}`))
    else outputs.set(file, result.content)
  }
  for (const feature of map.features) add(feature.file, renderFeatureDoc(existing.get(feature.file), feature, map))
  add(BROWSER_MAP_INDEX, renderIndexDoc(existing.get(BROWSER_MAP_INDEX), map, orphans))

  const specs = await generatedSpecs(cwd, map, options.specs, loaded.plans)
  // A spec without the header is the author's, whatever directory it sits in: never rewritten or removed.
  const generated = (content: string): boolean => content.startsWith(GENERATED_HEADER)
  // On a case-insensitive filesystem a name differing only by case is the same file.
  const byCase = new Map([...specs.onDisk.keys()].map((file) => [file.toLowerCase(), file]))
  for (const [file, content] of specs.outputs) {
    const other = byCase.get(file.toLowerCase())
    if (other !== undefined && other !== file) problems.push(`${other}: it differs from ${file} only by case; rename or move it`)
    const current = specs.onDisk.get(file)
    if (current !== undefined && !generated(current)) problems.push(`${file}: it has no generated header, so it is yours; move it out of ${file.startsWith(`${GENERATED_BEHAVIOURS_DIR}/`) ? GENERATED_BEHAVIOURS_DIR : GENERATED_SPECS_DIR}/`)
    outputs.set(file, content)
    if (current !== undefined) existing.set(file, current)
  }
  if (problems.length > 0) {
    throw new CliError(`Nothing was written; these files cannot be rewritten safely:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  }
  const removed = [...specs.onDisk].filter(([file, content]) => generated(content) && !specs.outputs.has(file)).map(([file]) => file)

  const changed = [...outputs].filter(([file, content]) => existing.get(file) !== content).map(([file]) => file)
  if (options.write) {
    for (const file of changed) {
      await mkdir(dirname(join(cwd, file)), { recursive: true })
      await writeFileAtomic(join(cwd, file), outputs.get(file)!)
    }
    for (const file of removed) await rm(join(cwd, file))
  }
  return {
    map, changed, orphans, removed,
    ...(specs.held ? { specsHeld: specs.held } : {}),
    ...(specs.accessibilityOff ? { accessibilityOff: specs.accessibilityOff } : {}),
    ...(specs.behavioursOff ? { behavioursOff: specs.behavioursOff } : {}),
    ...(specs.unlabelledInputs ? { unlabelledInputs: specs.unlabelledInputs } : {}),
  }
}
