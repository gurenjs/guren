import { UI_CATALOG_HEIGHT_MESSAGE, UI_CATALOG_JSON_PATH } from '../dev-center-links'
import { commandRow, el } from '../docs-viewer-page/dom'
import { gurenCommandLine } from '../shell-quote'
import type { UiCatalog, UiCatalogComponent } from '../ui-catalog'

export interface UiComponentDescription {
  badge: string
  tone: 'ok' | 'warn' | 'muted'
  detail: string
  command?: string
}

/** How the catalog reads one copy's state, which `planUiComponent()` judged on the server. */
export function describeUiComponent(component: UiCatalogComponent): UiComponentDescription {
  const name = component.name.toLowerCase()
  const template = component.template ?? `the ${component.name} template`
  switch (component.state) {
    case 'current':
      return { badge: 'matches template', tone: 'ok', detail: `Matches ${template}, the template this CLI ships.` }
    case 'update':
      return {
        badge: 'earlier release',
        tone: 'warn',
        detail: `An unedited copy of an earlier release's template. guren upgrade replaces it with ${template}.`,
        command: gurenCommandLine(['upgrade']),
      }
    case 'edited':
      return {
        badge: 'edited',
        tone: 'warn',
        detail: `${component.claimed ? `Its header names ${component.claimed}, but the file` : 'The file'} matches no released template, so guren upgrade leaves it as it is. Compare it with ${template}:`,
        command: gurenCommandLine(['add', 'ui', name, '--diff']),
      }
    case 'missing':
      return { badge: 'not copied', tone: 'muted', detail: 'The app has no copy.', command: gurenCommandLine(['add', 'ui', name]) }
  }
}

function componentRow(component: UiCatalogComponent): HTMLElement {
  const described = describeUiComponent(component)
  const row = el('div', 'ui-row')
  const head = el('div')
  head.append(el('div', 'g-card-title', component.name), el('div', 'meta mono', component.path))
  const body = el('div')
  body.append(el('span', `g-badge g-badge-${described.tone}`, described.badge), el('p', 'meta', described.detail))
  if (described.command) body.append(commandRow(described.command))
  row.append(head, body)
  return row
}

let listening: string | undefined
function sizeFrameFrom(frame: HTMLIFrameElement, origin: string): void {
  if (listening === origin) return
  listening = origin
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.origin !== origin || event.source !== frame.contentWindow) return
    const data = event.data as { type?: unknown; height?: unknown } | null
    if (data?.type === UI_CATALOG_HEIGHT_MESSAGE && typeof data.height === 'number') frame.style.height = `${Math.ceil(data.height)}px`
  })
}

function preview(catalog: UiCatalog): HTMLElement[] {
  if ('unavailable' in catalog.preview) return [el('p', 'warning', catalog.preview.unavailable)]
  const url = catalog.preview.url
  const frame = el('iframe', 'ui-preview')
  frame.title = 'Copied components rendered by the app'
  frame.src = url
  sizeFrameFrom(frame, new URL(url).origin)
  const reload = el('button', 'g-btn g-btn-secondary', 'Reload preview')
  reload.type = 'button'
  reload.onclick = () => { frame.src = url }
  const source = el('p', 'meta')
  source.append('Rendered by the app\'s Vite dev server at ', el('code', 'mono', url), ' with the app\'s own stylesheet. If it stays blank, check that vite.config.ts lists routeTypesPlugin() from @guren/cli/vite.')
  return [source, reload, frame]
}

function card(title: string, ...body: Node[]): HTMLElement {
  const section = el('section', 'g-card wide')
  const head = el('div', 'g-card-head')
  head.append(el('h2', 'g-card-title', title))
  const inner = el('div', 'g-card-body')
  inner.append(...body)
  section.append(head, inner)
  return section
}

export async function loadUiCatalog(status: HTMLElement, body: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true
  status.textContent = 'Reading the copied components…'
  status.className = ''
  try {
    const response = await fetch(UI_CATALOG_JSON_PATH, { cache: 'no-store', redirect: 'error' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const catalog = await response.json() as UiCatalog
    const copied = catalog.components.filter((component) => component.state !== 'missing').length
    status.textContent = `${copied} of ${catalog.components.length} components copied into ${catalog.dir}`
    body.replaceChildren(
      card('Copies', ...catalog.components.map(componentRow)),
      card('Preview', ...(copied ? preview(catalog) : [el('p', 'meta', 'No component is copied yet.'), commandRow(gurenCommandLine(['add', 'ui']))])),
    )
  } catch (error) {
    status.textContent = `Components unavailable: ${error instanceof Error ? error.message : 'Read failed'}. Refresh to retry.`
    status.className = 'error'
  } finally { button.disabled = false }
}
