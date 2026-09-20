/** The verdict and comment someone leaves on an element, kept per plan hash (RFC 0030 §4). */

import type { PlanFeedback } from '../feedback'
import { el, idMap, type IdMap } from './dom'
import { ariaLabel, currentLocale, localise, t, tel } from './locale'

type Verdict = NonNullable<PlanFeedback['elements'][number]['verdict']>

interface ReviewEntry {
  verdict: Verdict | null
  comment: string
}

const VERDICTS: ReadonlyArray<{ key: Verdict; label: string }> = [
  { key: 'approve', label: 'review.approve' },
  { key: 'changes', label: 'review.requestChanges' },
]

const MARK_LABELS = { approve: 'mark.approve', changes: 'mark.changes', noted: 'mark.noted', clean: 'mark.clean' }

let storageKey: string | null = null
let review = idMap<ReviewEntry>()

function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.some((verdict) => verdict.key === value)
}

/**
 * What comes back from storage is not this page's output: another document on the
 * same origin can write the key, and an older version of this page may have
 * written a different shape. Entries that are not `{ verdict, comment }` are
 * dropped rather than carried into the export.
 */
function restore(stored: unknown): IdMap<ReviewEntry> {
  const record = idMap<ReviewEntry>()
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return record
  for (const id of Object.keys(stored)) {
    const entry: unknown = (stored as Record<string, unknown>)[id]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { verdict: given, comment: said } = entry as Record<string, unknown>
    const verdict = isVerdict(given) ? given : null
    const comment = typeof said === 'string' ? said : ''
    if (verdict === null && comment === '') continue
    record[id] = { verdict: verdict, comment: comment }
  }
  return record
}

/** A draft has no hash, so nothing to key a stored review by. */
export function loadReview(planHash: string | null): void {
  storageKey = planHash ? 'guren.plan.review.' + planHash : null
  if (!storageKey) return
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw) review = restore(JSON.parse(raw))
  } catch {
    review = idMap()
  }
}

function saveReview(): void {
  if (!storageKey) return
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(reviewed()))
  } catch {
    /* A page that cannot persist still works; the export is the durable output. */
  }
}

/**
 * Only the elements someone touched. An entry emptied again during this session
 * is dropped here, which is the same rule `restore()` applies on the way in.
 */
function reviewed(): IdMap<ReviewEntry> {
  const touched = idMap<ReviewEntry>()
  for (const id of Object.keys(review)) {
    const entry = review[id]
    if (entry && (entry.verdict || entry.comment)) touched[id] = entry
  }
  return touched
}

export function reviewedElements(): PlanFeedback['elements'] {
  const touched = reviewed()
  return Object.keys(touched).map((id) => {
    const entry = touched[id] as ReviewEntry
    return { elementId: id, verdict: entry.verdict, comment: entry.comment }
  })
}

/**
 * The record holds an entry from the first time someone touches that element.
 * Seeding one per card instead would make every keystroke in any comment box
 * walk every element on the page.
 */
function entryFor(id: string): ReviewEntry {
  return (review[id] ??= { verdict: null, comment: '' })
}

/**
 * A mark in the card's heading, and the controls behind it. RFC 0030 §4 makes a
 * verdict part of the protocol (an approved element is locked, and an op on it
 * must say it reopens), so every element carries one without a permanent row of
 * controls.
 */
export function reviewControls(id: string): { mark: HTMLButtonElement; panel: HTMLDivElement } {
  const panel = el('div', 'review')
  panel.hidden = true
  const verdicts = el('div', 'verdicts')
  const buttons: Array<{ key: Verdict; button: HTMLButtonElement }> = []
  const mark = el('button', 'mark')
  mark.type = 'button'
  mark.setAttribute('aria-expanded', 'false')
  ariaLabel(mark, 'review.open', { id: id })

  const state = (): keyof typeof MARK_LABELS => {
    const entry = review[id]
    if (!entry) return 'clean'
    if (entry.verdict) return entry.verdict
    return entry.comment ? 'noted' : 'clean'
  }

  const sync = (): void => {
    const now = state()
    mark.className = 'mark mark-' + now
    mark.textContent = t(MARK_LABELS[now])
    for (const pair of buttons) pair.button.setAttribute('aria-pressed', now === pair.key ? 'true' : 'false')
  }

  for (const verdict of VERDICTS) {
    const button = tel('button', verdict.key, verdict.label)
    button.type = 'button'
    button.addEventListener('click', () => {
      const entry = entryFor(id)
      entry.verdict = entry.verdict === verdict.key ? null : verdict.key
      sync()
      saveReview()
    })
    buttons.push({ key: verdict.key, button: button })
    verdicts.appendChild(button)
  }
  panel.appendChild(verdicts)

  const box = el('textarea')
  box.rows = 2
  box.value = (review[id] || { comment: '' }).comment
  localise(() => {
    box.placeholder = t('review.placeholder')
  })
  ariaLabel(box, 'review.commentOn', { id: id })
  box.addEventListener('input', () => {
    entryFor(id).comment = box.value
    sync()
    saveReview()
  })
  panel.appendChild(box)

  mark.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    mark.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true')
    if (!panel.hidden) box.focus()
  })

  // The mark's word depends on the state, so it is re-read rather than bound to one key.
  localise(() => {
    mark.setAttribute('lang', currentLocale())
    panel.setAttribute('lang', currentLocale())
    sync()
  })
  return { mark: mark, panel: panel }
}
