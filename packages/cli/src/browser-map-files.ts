/**
 * `guren browser:map` (RFC 0033 §2): reads the graph and the approved plans, renders every
 * document, and writes only when every document can be rewritten safely. A file with no feature
 * any more is reported and kept, since it holds author text. Once `guren add browser-tests` has
 * written its config, the specs under `tests/browser/generated/` are kept here too (§6): a
 * generated spec nothing produces any more is removed, since no author text lives in one.
 */

import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

import { loadApplicationGraph } from './application-graph-load'
import {
  BROWSER_MAP_DIR, BROWSER_MAP_INDEX, buildBrowserMap, renderFeatureDoc, renderIndexDoc,
  type ApprovedPlanInput, type BrowserMap,
} from './browser-map'
import {
  BROWSER_TESTS_CONFIG, BROWSER_TESTS_SETUP, buildPlanSpecs, buildSmokeSpec, GENERATED_HEADER, GENERATED_SPECS_DIR, SMOKE_SPEC_FILE,
} from './browser-specs'
import { CliError } from './cli-error'
import { compareStrings } from './spec-artifact'
import { relativeUnreadableDirs, toPosixRelative } from './discovery'
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
  for (const name of names.filter((entry) => entry.endsWith(suffix)).sort()) {
    const file = `${dir}/${name}`
    files.set(file, await readFile(join(cwd, file), 'utf8'))
  }
  return files
}

/** The map as `browser:map`, `add browser-tests` and the generated specs read it: the introspected graph and the approved plans. */
export async function loadBrowserMap(cwd: string): Promise<BrowserMap> {
  const [graph, { plans, unreadable }] = await Promise.all([loadApplicationGraph({ cwd, introspect: true }), approvedPlans(cwd)])
  return buildBrowserMap(graph, plans, unreadable)
}

/** The generated specs a run writes, and the specs on disk beside them; none until the browser-tests config exists. */
async function generatedSpecs(cwd: string, map: BrowserMap): Promise<{ outputs: Map<string, string>; onDisk: Map<string, string> }> {
  if (!(await pathExists(join(cwd, BROWSER_TESTS_CONFIG)))) return { outputs: new Map(), onDisk: new Map() }
  const options = { signIn: await pathExists(join(cwd, BROWSER_TESTS_SETUP)) }
  const outputs = new Map([[SMOKE_SPEC_FILE, buildSmokeSpec(map, options)], ...buildPlanSpecs(map, options).map((entry): [string, string] => [entry.path, entry.contents])])
  const onDisk = new Map([...await readExisting(cwd, GENERATED_SPECS_DIR, '.browser.ts'), ...await readExisting(cwd, `${GENERATED_SPECS_DIR}/plans`, '.browser.ts')])
  return { outputs, onDisk }
}

/** Every document as a run would leave it; refuses, writing nothing, when any document's markers are unsafe. */
export async function runBrowserMap(options: { cwd: string; write: boolean; map?: BrowserMap }): Promise<BrowserMapRun> {
  const cwd = resolve(options.cwd)
  const [map, existing] = await Promise.all([options.map ?? loadBrowserMap(cwd), readExisting(cwd, BROWSER_MAP_DIR, '.md')])

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

  const specs = await generatedSpecs(cwd, map)
  // A spec without the header is the author's, whatever directory it sits in: never rewritten or removed.
  const generated = (content: string): boolean => content.startsWith(GENERATED_HEADER)
  for (const [file, content] of specs.outputs) {
    const current = specs.onDisk.get(file)
    if (current !== undefined && !generated(current)) problems.push(`${file}: it has no generated header, so it is yours; move it out of ${GENERATED_SPECS_DIR}/`)
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
  return { map, changed, orphans, removed }
}
