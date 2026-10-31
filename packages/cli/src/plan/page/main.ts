/**
 * The plan page's entry. The build bundles it into one classic script inside the
 * template, so the rendered file references nothing outside itself. Imports from
 * outside `page/` are types, except `../version`, which holds no code.
 */

// A classic script is sloppy unless it says otherwise, and the bundler keeps this directive.
'use strict'

import { PLAN_VERSION } from '../version'
import { indexPlan } from './card'
import { mountDiagram } from './diagram'
import { byId } from './dom'
import { feedbackDocument, mountFeedback } from './feedback'
import { renderHeader, renderPinned } from './header'
import { initLocale, mountLocaleSwitch, words } from './locale'
import { mountFilters, mountTabs } from './navigation'
import type { PlanPagePayload } from './payload'
import { refreshAnswers, renderQuestions } from './questions'
import { loadReview, seedReview } from './review'
import { diagramHost } from './sections'
import { loadServedFeedback, servedReview, startAutosave } from './served'

const REFUSED_CHROME = ['plan-meta', 'plan-scope', 'questions', 'tabs', 'controls', 'panels', 'footer']

/**
 * A plan of another version is refused whole: drawing the fields this page happens
 * to understand would show a partial plan as if it were the plan.
 */
function refuse(found: unknown): void {
  words(byId('plan-title'), 'version.heading')
  words(byId('plan-summary'), 'version.unsupported', { found: String(found), supported: PLAN_VERSION })
  for (const id of REFUSED_CHROME) byId(id).hidden = true
}

async function start(): Promise<void> {
  const data = JSON.parse(byId('plan-data').textContent) as PlanPagePayload
  initLocale(data.i18n)

  const version: unknown = data.plan.planVersion
  if (version !== PLAN_VERSION) {
    refuse(version)
    return
  }

  // Read before anything renders: each card and question starts from the review it shows.
  const served = servedReview()
  const saved = served ? await loadServedFeedback(served.feedbackUrl, data.planDigest) : null

  indexPlan(data)
  renderHeader(data)
  renderPinned(data)
  renderQuestions(data.plan.questions, saved?.answers)
  loadReview(data.planHash)
  if (saved) seedReview(saved.elements)
  mountTabs(data)
  refreshAnswers()
  if (diagramHost) mountDiagram(diagramHost, data.diagram)
  mountFilters(data.entities)
  mountFeedback(data, served?.savedTo ?? null)
  if (served) startAutosave(served.feedbackUrl, data.planDigest, () => feedbackDocument(data.planHash), byId('save-status'))
  mountLocaleSwitch()
}

void start()
