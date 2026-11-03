/**
 * The view's visits kept out of the host's tab (RFC 0038 §5). A view's frame
 * shares the tab's joint session history: every `pushState()` is an entry the
 * host page's Back button walks, and a `history.back()` past the view's first
 * entry navigates the frame away. So pushes become replaces plus an entry here,
 * and back/forward move in this list and dispatch the `popstate` Inertia
 * restores a page from.
 */

export interface HistoryTarget {
  history: History
  location: { href: string }
  dispatchEvent(event: Event): boolean
}

export interface MemoryHistory {
  readonly index: number
  urls(): string[]
}

interface Entry {
  state: unknown
  url: string
}

export function installMemoryHistory(target: HistoryTarget, initialUrl: string): MemoryHistory {
  const { history } = target
  const nativeReplace = history.replaceState.bind(history)
  const absolute = (url?: string | URL | null) => new URL(url ?? target.location.href, target.location.href).href
  // A refusal (Chrome throttles replaceState; quota) keeps the entry here only, never
  // reaching Inertia's `historyQuotaExceeded` handler, which assigns `window.location`.
  const replace = (state: unknown, url: string) => {
    try {
      nativeReplace(state, '', url)
    } catch {
      // The list below stays authoritative.
    }
  }

  // Before mounting: Inertia renders the first page before it writes the page's
  // `url`, so a relative link would otherwise resolve against the sandbox document.
  replace(history.state, absolute(initialUrl))
  const entries: Entry[] = [{ state: history.state, url: absolute(initialUrl) }]
  let index = 0

  const go = (delta: number) => {
    const next = index + delta
    if (next < 0 || next >= entries.length) return
    index = next
    const entry = entries[index]!
    replace(entry.state, entry.url)
    setTimeout(() => target.dispatchEvent(popState(entry.state)), 0)
  }

  history.pushState = (state: unknown, _unused: string, url?: string | URL | null) => {
    const href = absolute(url)
    entries.splice(index + 1)
    entries.push({ state, url: href })
    index = entries.length - 1
    replace(state, href)
  }
  history.replaceState = (state: unknown, _unused: string, url?: string | URL | null) => {
    const href = absolute(url)
    entries[index] = { state, url: href }
    replace(state, href)
  }
  history.back = () => go(-1)
  history.forward = () => go(1)
  history.go = (delta?: number) => go(delta ?? 0)

  return {
    get index() {
      return index
    },
    urls: () => entries.map((entry) => entry.url),
  }
}

function popState(state: unknown): Event {
  if (typeof PopStateEvent === 'function') return new PopStateEvent('popstate', { state })
  const event = new Event('popstate') as Event & { state: unknown }
  Object.defineProperty(event, 'state', { value: state })
  return event
}
