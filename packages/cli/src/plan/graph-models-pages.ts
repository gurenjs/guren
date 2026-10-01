import type { ModelGraphReading } from '../application-graph-models'
import type { PageGraphReading } from '../application-graph-pages'
import { formatTruncatedList } from '../discovery'
import type { PlanAppNames } from './app-state'

export function planModelSection(reading: ModelGraphReading): PlanAppNames {
  if (reading.unreadableFiles.length) {
    return { unreadable: `${reading.unreadableFiles.length} model file(s) could not be read: ${formatTruncatedList(reading.unreadableFiles)}` }
  }
  return reading.primaryNodes.map(({ label, module }) => ({ name: label, module }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function planPageSection(reading: PageGraphReading): PlanAppNames {
  // RFC 0030 retains duplicate IDs and excludes the entire contracts prefix from approval facts.
  return reading.candidates.map(({ label }) => label).filter((name) => !name.startsWith('contracts')).sort()
    .map((name) => ({ name, module: null }))
}
