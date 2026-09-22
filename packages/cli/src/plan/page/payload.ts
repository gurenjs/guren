/**
 * What `render.ts` embeds and the page reads back. Both sides import these types, so
 * a field one of them renames fails the other's type check. Type-only: the page bundle
 * must not pull the schema's validator in with it.
 */

import type { PlanDiagram } from '../diagram'
import type { PlanFlowLayout } from '../flow'
import type { PlanImpactEntry } from '../impact'
import type { PlanDictionary, PlanLocale } from '../locales'
import type { Plan, PlanDraft, PlanElementSection } from '../schema'
import type { PlanCheckResult } from '../validate'

export interface PlanBreakingChange {
  elementId: string
  section: PlanElementSection
  title: string
  /** A `breaking.*` key of the page's dictionaries: the page says it in whichever locale it speaks. */
  reasonKey: string
  reasonValues: Record<string, string>
}

/** The page's own words in every locale it can switch to, and the one it opens in. */
export interface PlanPageI18n {
  initial: PlanLocale
  dictionaries: Record<PlanLocale, PlanDictionary>
}

/** One element in the page's own index: which entity's filter shows it. */
export interface PlanElementEntry {
  id: string
  entity: string | null
}

/** One id referencing another, so the page can show a card's outgoing and incoming links. */
export interface PlanLink {
  from: string
  to: string
  label: string
}

export interface PlanPagePayload {
  plan: PlanDraft | Plan
  /** Absent for a draft: identity covers the baseline, which a draft does not have. */
  planHash: string | null
  checks: PlanCheckResult[]
  breaking: PlanBreakingChange[]
  /** `null` when the page was rendered with no application to read, which is not an empty Impact. */
  impact: PlanImpactEntry[] | null
  diagram: PlanDiagram
  /** Placed here rather than in the page: a flow's layout is the same everywhere it is drawn. */
  flows: PlanFlowLayout[]
  /** Absent when no name was given, or the given one is not safe to spell in a command. */
  planFile: string | null
  elements: PlanElementEntry[]
  links: PlanLink[]
  entities: string[]
  status: unknown
  i18n: PlanPageI18n
}
