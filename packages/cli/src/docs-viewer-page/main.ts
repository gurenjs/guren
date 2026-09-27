/**
 * The docs viewer's entry (RFC 0005). The build bundles it into one classic script inside the
 * template; imports from outside this directory are types only, so no CLI code reaches the page.
 */

// A classic script is sloppy unless it says otherwise, and the bundler keeps this directive.
'use strict'

import type { DocsViewerData } from '../docs-viewer'
import { byId } from './dom'
import { mountGraph, rebuild } from './graph'
import { closePanel, mountPanel, toggleExpanded } from './panel'
import { mountResize } from './resize'
import { BASE_URL, state } from './state'
import { fitView, mountZoom, zoomIn, zoomOut } from './zoom'

const POLL_MS = 5000

let etag: string | null = null

async function load(): Promise<void> {
  try {
    const response = await fetch(`${BASE_URL}/data.json`, { headers: etag ? { 'If-None-Match': etag } : {} })
    if (response.status === 304 || !response.ok) return
    etag = response.headers.get('etag')
    rebuild((await response.json()) as DocsViewerData)
  } catch {
    // Dev server restarting (bun --hot): the next poll catches up.
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
