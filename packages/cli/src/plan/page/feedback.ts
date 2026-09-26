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

  words(byId('copy-prompt'), 'footer.copyPrompt')
  words(byId('copy'), 'footer.copy')
  words(byId('export'), 'footer.download')
  // `comparePlanDictionaries()` refuses a value spelling `:name` (`extractPlaceholders()` counts it), so the command comes in as `{command}`.
  words(byId('footer-prompt-note'), 'footer.promptNote', { command: 'plan:revise' })
  words(byId('footer-note'), 'footer.note')
  words(byId('footer-revise-note'), 'footer.revise', { command: 'plan:revise' })
  words(byId('footer-approve-note'), 'footer.approve')

  // `planFile` is already held to a relative path with no shell metacharacter, because
  // these lines exist to be pasted into a shell. `plan:revise` also needs the edited
  // copy, which only the reader can name, so `footer.revise` describes it in words and
  // the page prints the two commands that follow a revision.
  const plan = planFile || '<plan.json>'
  byId('render-command').textContent = 'bunx guren plan:render ' + plan
  byId('approve-command').textContent = 'bunx guren plan:approve ' + plan

  // Clipboard, not the network: `file://` is a secure context, and no policy
  // directive governs it. A refusal (permission, or an older engine) says so.
  const copy = (text: string, copied: string): void => {
    window.navigator.clipboard.writeText(text).then(
      () => say(copied),
      () => say('footer.clipboardRefused'),
    )
  }
  // The prompt is in the page's current locale, so the agent answers in the reader's language.
  byId('copy-prompt').addEventListener('click', () => {
    copy(`${t('footer.prompt', { plan })}\n\n\`\`\`json\n${feedbackJson(planHash)}\n\`\`\`\n`, 'footer.promptCopied')
  })
  byId('copy').addEventListener('click', () => copy(feedbackJson(planHash), 'footer.copied'))

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
