/**
 * `guren browser:map` (RFC 0033 §2): reads the graph and the approved plans, renders every
 * document, and writes only when every document can be rewritten safely. A file with no feature
 * any more is reported and kept, since it holds author text.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { loadApplicationGraph } from './application-graph-load'
import {
  BROWSER_MAP_DIR, BROWSER_MAP_INDEX, buildBrowserMap, renderFeatureDoc, renderIndexDoc,
  type ApprovedPlanInput, type BrowserMap,
} from './browser-map'
import { CliError } from './cli-error'
import { relativeUnreadableDirs, toPosixRelative } from './discovery'
import { discoverPlanFiles } from './plan-check'
import { writeFileAtomic } from './plan/beside'
import { readApprovedPlan } from './plan/open-plan'

interface BrowserMapRun {
  map: BrowserMap
  /** App-relative paths whose content a run writes differently from what is on disk. */
  changed: string[]
  orphans: string[]
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
  return { plans, unreadable }
}

async function readExisting(cwd: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  let names: string[]
  try {
    names = await readdir(join(cwd, BROWSER_MAP_DIR))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw new CliError(`${BROWSER_MAP_DIR} could not be read: ${(error as Error).message}`)
  }
  for (const name of names.filter((entry) => entry.endsWith('.md')).sort()) {
    const file = `${BROWSER_MAP_DIR}/${name}`
    files.set(file, await readFile(join(cwd, file), 'utf8'))
  }
  return files
}

/** Every document as a run would leave it; refuses, writing nothing, when any document's markers are unsafe. */
export async function runBrowserMap(options: { cwd: string; write: boolean }): Promise<BrowserMapRun> {
  const cwd = resolve(options.cwd)
  const [graph, { plans, unreadable }, existing] = await Promise.all([
    loadApplicationGraph({ cwd, introspect: true }), approvedPlans(cwd), readExisting(cwd),
  ])
  const map = buildBrowserMap(graph, plans, unreadable)

  const featureFiles = new Set<string>()
  for (const feature of map.features) {
    if (featureFiles.has(feature.file)) throw new CliError(`Two features write ${feature.file}; rename a page directory so their names differ by more than case and punctuation.`)
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
  if (problems.length > 0) {
    throw new CliError(`Nothing was written; these markers cannot be rewritten safely:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  }

  const changed = [...outputs].filter(([file, content]) => existing.get(file) !== content).map(([file]) => file)
  if (options.write && changed.length > 0) {
    await mkdir(join(cwd, BROWSER_MAP_DIR), { recursive: true })
    for (const file of changed) await writeFileAtomic(join(cwd, file), outputs.get(file)!)
  }
  return { map, changed, orphans }
}
