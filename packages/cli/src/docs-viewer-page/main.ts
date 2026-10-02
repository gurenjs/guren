/**
 * The docs viewer's entry (RFC 0005). The build bundles it into one classic script inside the
 * template; imports from outside this directory are types only, so no CLI code reaches the page.
 */

// A classic script is sloppy unless it says otherwise, and the bundler keeps this directive.
'use strict'

import type { DocsViewerData } from '../docs-viewer'
import { byId } from './dom'
import { mountGraph, rebuild } from './graph'
import { loadFailureNotice, type LoadFailure } from './model'
import { closePanel, mountPanel, toggleExpanded } from './panel'
import { mountResize } from './resize'
import { BASE_URL, state } from './state'
import { fitView, mountZoom, zoomIn, zoomOut } from './zoom'

const POLL_MS = 5000

let etag: string | null = null
let loaded = false
let failedPolls = 0

function report(failure: LoadFailure | null): void {
  failedPolls = failure ? failedPolls + 1 : 0
  const notice = failure ? loadFailureNotice(failure, failedPolls, loaded) : null
  const host = byId('load-error')
  // A live region, never hidden (a region revealed already filled goes unannounced), and
  // rewriting the same text on every poll would announce it again.
  if (host.textContent !== (notice ?? '')) host.textContent = notice ?? ''
}

async function load(): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${BASE_URL}/data.json`, { headers: etag ? { 'If-None-Match': etag } : {} })
  } catch {
    report({ kind: 'unreachable' })
    return
  }
  if (response.status === 304) return report(null)
  if (!response.ok) return report({ kind: 'status', status: response.status })
  try {
    rebuild((await response.json()) as DocsViewerData)
    // Only after the rebuild: a payload it threw on must not be answered 304 from then on.
    etag = response.headers.get('etag')
    loaded = true
    report(null)
  } catch (error) {
    report({ kind: 'unreadable', message: error instanceof Error ? error.message : String(error) })
  }
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closePanel()
  const typing = ev.target instanceof HTMLElement && ev.target.matches('input, textarea')
  if (ev.key === 'f' && state.selected && !typing && !ev.metaKey && !ev.ctrlKey) {
    ev.preventDefault()
    toggleExpanded()
  }
  const inPanel = ev.target instanceof Element && ev.target.closest('.panel') !== null
  if (typing || inPanel || ev.metaKey || ev.ctrlKey || ev.altKey) return
  if (ev.key === '+' || ev.key === '=') zoomIn()
  else if (ev.key === '-') zoomOut()
  else if (ev.key === '0') fitView()
}

mountGraph()
mountPanel()
mountResize()
mountZoom()
addEventListener('keydown', onKey)
byId('subtitle').textContent = `OKF bundle · ${location.host}`
void load()
setInterval(() => {
  if (!document.hidden) void load()
}, POLL_MS)
