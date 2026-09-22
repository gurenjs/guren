/** The feedback document a reviewer hands back (RFC 0030 §4), and the two ways out of the page. */

import type { PlanFeedback } from '../feedback'
import { byId, el } from './dom'
import { localise, t, words } from './locale'
import type { PlanPagePayload } from './payload'
import { givenAnswers } from './questions'
import { reviewedElements } from './review'

function feedbackJson(planHash: string | null): string {
  const feedback: PlanFeedback = { answers: givenAnswers(), elements: reviewedElements() }
  if (planHash) feedback.planHash = planHash
  return JSON.stringify(feedback, null, 2)
}

export function mountFeedback({ planHash, planFile }: PlanPagePayload): void {
  const exportStatus = byId('export-status')
  let statusTimer: number | null = null

  const say = (key: string): void => {
    exportStatus.textContent = t(key)
    if (statusTimer) window.clearTimeout(statusTimer)
    statusTimer = window.setTimeout(() => {
      exportStatus.textContent = ''
    }, 4000)
  }
  // A status line is a sentence in the locale it was said in.
  localise(() => {
    exportStatus.textContent = ''
  })

  words(byId('copy'), 'footer.copy')
  words(byId('export'), 'footer.download')
  words(byId('footer-note'), 'footer.note')
  words(byId('footer-revise-note'), 'footer.revise')
  words(byId('footer-approve-note'), 'footer.approve')

  // `planFile` is already held to a bare name with no shell metacharacter, because
  // these lines exist to be pasted into a shell. No command reads the feedback yet
  // (`plan --revise` is RFC 0030 Part 3), so the page names the two that follow a revision.
  const plan = planFile || '<plan.json>'
  byId('render-command').textContent = 'bunx guren plan:render ' + plan
  byId('approve-command').textContent = 'bunx guren plan:approve ' + plan

  byId('copy').addEventListener('click', () => {
    // Clipboard, not the network: `file://` is a secure context, and no policy
    // directive governs it. A refusal (permission, or an older engine) says so.
    window.navigator.clipboard.writeText(feedbackJson(planHash)).then(
      () => say('footer.copied'),
      () => say('footer.clipboardRefused'),
    )
  })

  byId('export').addEventListener('click', () => {
    const blob = new Blob([feedbackJson(planHash)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = el('a')
    anchor.href = url
    anchor.download = 'feedback.json'
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    say('footer.downloaded')
  })
}
