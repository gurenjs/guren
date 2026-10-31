/**
 * The Dev Center's review (RFC 0030 §8, served mode): the page loads the feedback saved for
 * this plan and posts the whole document after each change. Only a page served at
 * `/_guren/plans/<slug>/review` does: the file's own policy has no `connect-src`, so a copy
 * opened anywhere else could not reach a server if it tried.
 */

import type { PlanFeedback } from '../feedback'
import { onReviewChange } from './changes'
import { t } from './locale'

const REVIEW_PATH = /^\/_guren\/plans\/[^/]+\/review$/
const SAVE_DELAY_MS = 600
const RETRY_CAP_MS = 30_000

/** The feedback endpoint beside this page, or `null` for the static page. */
export function servedFeedbackUrl(): string | null {
  if (!/^https?:$/.test(window.location.protocol) || !REVIEW_PATH.test(window.location.pathname)) return null
  return window.location.pathname.replace(/review$/, 'feedback')
}

/**
 * The saved review and the file it is in, `saved: null` when none names this version. A failed read is
 * `null` as a whole: the first save would replace a review the page never loaded, so saving stays off.
 */
export async function loadServedFeedback(url: string, planDigest: string): Promise<{ file: string; saved: PlanFeedback | null } | null> {
  try {
    const response = await window.fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return null
    const body = (await response.json()) as { file?: unknown; saved?: { planDigest?: unknown; feedback?: unknown } | null }
    if (typeof body.file !== 'string') return null
    const saved = body.saved
    const current = saved && saved.planDigest === planDigest && isFeedback(saved.feedback) ? saved.feedback : null
    return { file: body.file, saved: current }
  } catch {
    return null
  }
}

/** The server validated it on the way in; this is only the shape the page reads, checked once here. */
function isFeedback(value: unknown): value is PlanFeedback {
  const feedback = value as PlanFeedback | null
  return !!feedback && Array.isArray(feedback.answers) && Array.isArray(feedback.elements)
}

/**
 * Posts the document a moment after the last change, one request at a time, and says how it went.
 * A save the server never answered (a restart mid `bun --hot` reload) is tried again with backoff;
 * one it refused is not, since the same document would be refused again. Leaving with a change
 * not yet saved asks first: the next visit loads the server's copy, which would not have it.
 */
export function startAutosave(url: string, planDigest: string, feedback: () => PlanFeedback, status: HTMLElement): void {
  let timer: number | null = null
  let saving = false
  let failed = false
  let failures = 0
  let lastSaved: string | null = null

  const schedule = (delay: number): void => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      // One request at a time: a change made during a save is posted after it.
      if (saving) schedule(SAVE_DELAY_MS)
      else void save()
    }, delay)
  }

  const save = async (): Promise<void> => {
    const body = JSON.stringify({ planDigest, feedback: feedback() })
    if (body === lastSaved) return
    saving = true
    status.textContent = t('footer.saving')
    let retry = false
    try {
      const response = await window.fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      const answer = (await response.json().catch(() => ({}))) as { savedAt?: string; error?: { message?: string } }
      failed = !response.ok
      retry = response.status >= 500
      if (response.ok) lastSaved = body
      status.textContent = response.ok
        ? t('footer.saved', { time: new Date(answer.savedAt ?? Date.now()).toLocaleTimeString() })
        : t('footer.saveFailed', { reason: answer.error?.message ?? String(response.status) })
    } catch {
      failed = true
      retry = true
      status.textContent = t('footer.saveFailed', { reason: t('footer.serverUnreachable') })
    } finally {
      saving = false
    }
    failures = retry ? failures + 1 : 0
    if (retry && !timer) schedule(Math.min(RETRY_CAP_MS, SAVE_DELAY_MS * 2 ** failures))
  }

  onReviewChange(() => schedule(SAVE_DELAY_MS))
  window.addEventListener('beforeunload', (event: Event) => {
    if (failed || timer || saving) event.preventDefault()
  })
}
