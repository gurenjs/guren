/**
 * The Dev Center's review (RFC 0030 §8, served mode): the page loads the feedback saved for
 * this plan and posts the whole document after each change. Only a page served at
 * `/_guren/plans/<slug>/review` does: the file's own policy has no `connect-src`, so a copy
 * opened anywhere else could not reach a server if it tried.
 */

import type { PlanFeedback } from '../feedback'
import { onReviewChange } from './changes'
import { t } from './locale'

const REVIEW_PATH = /^\/_guren\/plans\/([^/]+)\/review$/
const SAVE_DELAY_MS = 600
const RETRY_CAP_MS = 30_000

/** The feedback endpoint beside this page and the file it saves to, or `null` for the static page. */
export function servedReview(): { feedbackUrl: string; savedTo: string } | null {
  const match = REVIEW_PATH.exec(window.location.pathname)
  if (!/^https?:$/.test(window.location.protocol) || !match) return null
  let slug: string
  try {
    slug = decodeURIComponent(match[1] as string)
  } catch {
    return null
  }
  return { feedbackUrl: window.location.pathname.replace(/review$/, 'feedback'), savedTo: `.guren/plans/${slug}.feedback.json` }
}

/** The saved feedback for the plan this page shows; anything else, including a failed read, is none. */
export async function loadServedFeedback(url: string, planDigest: string): Promise<PlanFeedback | null> {
  try {
    const response = await window.fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) return null
    const body = (await response.json()) as { saved?: { planDigest?: unknown; feedback?: unknown } | null }
    const saved = body.saved
    if (!saved || saved.planDigest !== planDigest || !saved.feedback || typeof saved.feedback !== 'object') return null
    return saved.feedback as PlanFeedback
  } catch {
    return null
  }
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
  let again = false
  let unsaved = false
  let failures = 0

  const schedule = (delay: number): void => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      void save()
    }, delay)
  }

  const save = async (): Promise<void> => {
    if (saving) {
      again = true
      return
    }
    saving = true
    unsaved = false
    status.textContent = t('footer.saving')
    let retry = false
    try {
      const response = await window.fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planDigest: planDigest, feedback: feedback() }),
      })
      const body = (await response.json().catch(() => ({}))) as { savedAt?: string; error?: { message?: string } }
      if (response.ok) {
        failures = 0
        status.textContent = t('footer.saved', { time: new Date(body.savedAt ?? Date.now()).toLocaleTimeString() })
      } else {
        unsaved = true
        retry = response.status >= 500
        status.textContent = t('footer.saveFailed', { reason: body.error?.message ?? String(response.status) })
      }
    } catch {
      unsaved = true
      retry = true
      status.textContent = t('footer.saveFailed', { reason: t('footer.serverUnreachable') })
    } finally {
      saving = false
      if (again) {
        again = false
        void save()
      } else if (retry) {
        failures += 1
        schedule(Math.min(RETRY_CAP_MS, SAVE_DELAY_MS * 2 ** failures))
      }
    }
  }

  onReviewChange(() => {
    unsaved = true
    schedule(SAVE_DELAY_MS)
  })
  window.addEventListener('beforeunload', (event: Event) => {
    if (unsaved || timer || saving) event.preventDefault()
  })
}
