/**
 * `guren browser:map` (RFC 0033 §2): reads the graph and the approved plans, renders every
 * document, and writes only when every document can be rewritten safely. A file with no feature
 * any more is reported and kept, since it holds author text.
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { loadApplicationGraph } from './application-graph-load'
import {
  BROWSER_MAP_DIR, BROWSER_MAP_INDEX, buildBrowserMap, renderFeatureDoc, renderIndexDoc,
  type ApprovedPlanInput, type BrowserMap,
} from './browser-map'
import { CliError } from './cli-error'
import { toPosixRelative } from './discovery'
import { discoverPlanFiles } from './plan-check'
import { readPlanFile } from './plan-render'
import { readPlanApprovalStanding } from './plan/approvals'
import { writeFileAtomic } from './plan/beside'
import { hasBaseline } from './plan/schema'

export interface BrowserMapRun {
  map: BrowserMap
  /** App-relative paths whose content a run writes differently from what is on disk. */
  changed: string[]
  orphans: string[]
}

/** Plans approved at their current hash, closed or not; a draft or an unapproved plan is skipped, an unreadable one reported. */
export async function approvedPlans(cwd: string): Promise<{ plans: ApprovedPlanInput[]; unreadable: BrowserMap['unreadablePlans'] }> {
  const discovery = await discoverPlanFiles(cwd)
  const unreadable: BrowserMap['unreadablePlans'] = discovery.unreadable.map((entry) => ({ plan: toPosixRelative(cwd, entry.dir), reason: entry.reason }))
  const plans: ApprovedPlanInput[] = []
  for (const path of discovery.files) {
    const file = toPosixRelative(cwd, path)
    try {
      const { plan } = await readPlanFile(path, cwd)
      const standing = await readPlanApprovalStanding(path, plan)
      if (standing?.state === 'unreadable') unreadable.push({ plan: file, reason: standing.reason })
      else if (standing?.state === 'approved' && hasBaseline(plan)) plans.push({ file, plan })
    } catch (error) {
      unreadable.push({ plan: file, reason: (error as Error).message })
    }
  }
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
  const graph = await loadApplicationGraph({ cwd, introspect: true })
  const { plans, unreadable } = await approvedPlans(cwd)
  const map = buildBrowserMap(graph, plans, unreadable)
  const existing = await readExisting(cwd)

  const featureFiles = new Set(map.features.map((feature) => feature.file))
  const duplicate = map.features.find((feature, index) => map.features.findIndex((other) => other.file === feature.file) !== index)
  if (duplicate) throw new CliError(`Two features write ${duplicate.file}; rename a page directory so their names differ by more than case and punctuation.`)
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
