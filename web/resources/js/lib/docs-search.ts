// The request half of the docs search box, kept out of the component so the
// one rule that matters here can be tested without a DOM.
//
// That rule: a search box issues a request per keystroke, and the responses do
// not come back in the order they were sent. Without a guard, a slow request
// for 「認」lands after a fast one for 「認証」and the reader watches their
// results revert to a stale query as they type.

export interface DocSearchHit {
  category: string
  slug: string
  anchor: string
  docTitle: string
  heading: string
  snippet: string
  url: string
}

export type DocSearchOutcome =
  | { status: 'ok'; hits: DocSearchHit[] }
  | { status: 'unavailable' }
  | { status: 'error' }

export type DocSearchLocale = 'en' | 'ja'

/** Matches the cap the route's query schema enforces; a longer one is a 422. */
export const MAX_QUERY_LENGTH = 64

export interface DocSearchRunner {
  /**
   * Resolves with the outcome for this query, or `null` when a newer call
   * superseded it. A `null` must leave the display alone rather than clear it.
   */
  run(query: string, locale: DocSearchLocale): Promise<DocSearchOutcome | null>
  /** Drop the in-flight request and stop its result from being delivered. */
  cancel(): void
}

interface RunnerOptions {
  fetch?: typeof globalThis.fetch
  endpoint?: string
}

export function createDocSearchRunner(options: RunnerOptions = {}): DocSearchRunner {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const endpoint = options.endpoint ?? '/docs/search'

  let latest = 0
  let inFlight: AbortController | null = null

  const cancel = (): void => {
    inFlight?.abort()
    inFlight = null
  }

  return {
    cancel,

    async run(query, locale) {
      const token = ++latest
      cancel()

      const controller = new AbortController()
      inFlight = controller

      const url = `${endpoint}?q=${encodeURIComponent(query.slice(0, MAX_QUERY_LENGTH))}&locale=${locale}`

      let response: Response
      try {
        response = await request(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
      } catch {
        // An abort is not a failure the reader should see — neither the one a
        // newer keystroke causes nor the one closing the modal causes, and the
        // second is why the signal is checked rather than only the token.
        return controller.signal.aborted || token !== latest ? null : { status: 'error' }
      }

      // Aborting a request whose response is already buffered does not
      // necessarily reject it, so a superseded call can arrive here intact.
      // Checked before the status is read as well as after the body is: a
      // stale 503 would otherwise paint "the index is not built" over a
      // perfectly good current query.
      if (token !== latest) {
        return null
      }

      if (response.status === 503) {
        return { status: 'unavailable' }
      }

      if (!response.ok) {
        return { status: 'error' }
      }

      let payload: { results?: DocSearchHit[] }
      try {
        payload = (await response.json()) as { results?: DocSearchHit[] }
      } catch {
        return controller.signal.aborted || token !== latest ? null : { status: 'error' }
      }

      if (token !== latest) {
        return null
      }

      return { status: 'ok', hits: payload.results ?? [] }
    },
  }
}

/** Long enough that a burst of typing is one request, short enough to feel live. */
export const SEARCH_DEBOUNCE_MS = 150

export interface DebouncedDocSearch {
  /**
   * Queue a search. Only the last query in a burst is sent, and only outcomes
   * that were not superseded reach `deliver`.
   */
  schedule(query: string, locale: DocSearchLocale, deliver: (outcome: DocSearchOutcome) => void): void
  /** Drop a queued search and any request already in flight. */
  cancel(): void
}

/**
 * Debouncing here rather than in the component so the property that matters
 * can be tested: `/docs/search` is rate limited, and one request per keystroke
 * would have the UI trip a limit meant for abuse.
 */
export function createDebouncedDocSearch(
  options: { runner?: DocSearchRunner; delayMs?: number } = {},
): DebouncedDocSearch {
  const runner = options.runner ?? createDocSearchRunner()
  const delayMs = options.delayMs ?? SEARCH_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    runner.cancel()
  }

  return {
    cancel,

    schedule(query, locale, deliver) {
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        timer = undefined
        void runner.run(query, locale).then((outcome) => {
          if (outcome !== null) {
            deliver(outcome)
          }
        })
      }, delayMs)
    },
  }
}
