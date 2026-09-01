import { Link } from '@inertiajs/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createDebouncedDocSearch,
  MAX_QUERY_LENGTH,
  type DocSearchHit,
  type DocSearchLocale,
  type DocSearchOutcome,
} from '../lib/docs-search.js'
import { SearchIcon, XIcon } from './icons.js'

const COPY = {
  en: {
    trigger: 'Search docs',
    placeholder: 'Search the documentation',
    dialogLabel: 'Search the documentation',
    idle: 'Type to search the guides and tutorials.',
    empty: 'No matches.',
    error: 'Search is unavailable right now. Try again in a moment.',
    unavailable: 'The search index has not been built for this deployment yet.',
    close: 'Close search',
    hint: 'to select',
    localeLabel: 'Search language',
  },
  ja: {
    trigger: 'ドキュメントを検索',
    placeholder: 'ドキュメントを検索',
    dialogLabel: 'ドキュメントを検索',
    idle: '入力するとガイドとチュートリアルを検索します。',
    empty: '一致するものがありません。',
    error: '検索を利用できません。しばらくしてからお試しください。',
    unavailable: 'このデプロイでは検索インデックスがまだ作られていません。',
    close: '検索を閉じる',
    hint: 'で移動',
    localeLabel: '検索する言語',
  },
} as const

const LOCALE_LABELS: Record<DocSearchLocale, string> = { en: 'English', ja: '日本語' }

type Display =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; hits: DocSearchHit[] }
  | { kind: 'empty' }
  | { kind: 'error' }
  | { kind: 'unavailable' }

/** The line shown in place of a result list, for every state that has none. */
function statusMessage(kind: Display['kind'], copy: (typeof COPY)[DocSearchLocale]): string {
  switch (kind) {
    case 'empty':
      return copy.empty
    case 'error':
      return copy.error
    case 'unavailable':
      return copy.unavailable
    case 'loading':
      return '…'
    default:
      return copy.idle
  }
}

/** A text field the reader is already typing in should keep the `/` key. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

interface DocSearchProps {
  /** The locale of the page this sits on; the reader can change it in the dialog. */
  locale: DocSearchLocale
  className?: string
}

export function DocSearch({ locale, className = '' }: DocSearchProps) {
  const copy = COPY[locale]
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [searchLocale, setSearchLocale] = useState<DocSearchLocale>(locale)
  const [display, setDisplay] = useState<Display>({ kind: 'idle' })
  const [selected, setSelected] = useState(0)
  // Resolved after mount: the server has no idea which keyboard this is, and
  // rendering a guess would mismatch during hydration.
  const [isApple, setIsApple] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLAnchorElement | null>>([])

  const search = useMemo(() => createDebouncedDocSearch(), [])

  useEffect(() => {
    setIsApple(/Mac|iPhone|iPad/u.test(navigator.platform || navigator.userAgent))
  }, [])

  // The dialog opens on the page's own language; a later page in the other
  // language should open on that one.
  useEffect(() => {
    setSearchLocale(locale)
  }, [locale])

  const close = useCallback(() => {
    setOpen(false)
    search.cancel()
    triggerRef.current?.focus()
  }, [search])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((wasOpen) => !wasOpen)
        return
      }
      if (event.key === '/' && !isTypingTarget(event.target) && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setOpen(true)
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    inputRef.current?.focus()
    // Selected, not cleared: reopening keeps the last query visible so it can
    // be refined, while typing still replaces it instead of appending.
    inputRef.current?.select()
    // The page behind the dialog must not scroll under it.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    const trimmed = query.trim()
    if (trimmed.length === 0) {
      search.cancel()
      setDisplay({ kind: 'idle' })
      return
    }

    setDisplay({ kind: 'loading' })
    setSelected(0)
    search.schedule(trimmed, searchLocale, (outcome: DocSearchOutcome) => {
      if (outcome.status === 'unavailable') {
        setDisplay({ kind: 'unavailable' })
      } else if (outcome.status === 'error') {
        setDisplay({ kind: 'error' })
      } else {
        setDisplay(outcome.hits.length > 0 ? { kind: 'results', hits: outcome.hits } : { kind: 'empty' })
      }
    })
  }, [open, query, searchLocale, search])

  useEffect(() => () => search.cancel(), [search])

  const hits = display.kind === 'results' ? display.hits : []

  useEffect(() => {
    optionRefs.current[selected]?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (hits.length === 0) {
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((index) => (index + 1) % hits.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((index) => (index - 1 + hits.length) % hits.length)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      // Click the link rather than navigating by hand, so Enter and a mouse
      // click take exactly the same path through Inertia.
      optionRefs.current[selected]?.click()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className={`flex w-full items-center gap-2 rounded-lg border border-docs-border bg-docs-panel px-3 py-2 text-left text-sm text-docs-text-muted transition hover:border-docs-border-strong hover:text-docs-text ${className}`}
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="flex-1 truncate">{copy.trigger}</span>
        <kbd className="docs-mono hidden shrink-0 rounded border border-docs-border px-1.5 py-0.5 text-[0.7rem] text-docs-text-muted sm:block">
          {isApple ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              close()
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={copy.dialogLabel}
            className="flex max-h-[70vh] w-full max-w-[640px] flex-col overflow-hidden rounded-xl border border-docs-border bg-docs-page shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-docs-border px-4 py-3">
              <SearchIcon className="size-5 shrink-0 text-docs-text-muted" />
              <input
                ref={inputRef}
                type="search"
                value={query}
                maxLength={MAX_QUERY_LENGTH}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onInputKeyDown}
                placeholder={copy.placeholder}
                aria-label={copy.placeholder}
                aria-autocomplete="list"
                aria-controls="docs-search-results"
                aria-activedescendant={hits.length > 0 ? `docs-search-hit-${selected}` : undefined}
                className="min-w-0 flex-1 bg-transparent text-base text-docs-text outline-none placeholder:text-docs-text-muted"
              />
              <label className="sr-only" htmlFor="docs-search-locale">
                {copy.localeLabel}
              </label>
              <select
                id="docs-search-locale"
                value={searchLocale}
                onChange={(event) => setSearchLocale(event.target.value as DocSearchLocale)}
                className="docs-mono shrink-0 rounded border border-docs-border bg-docs-panel px-2 py-1 text-xs text-docs-text-secondary"
              >
                {(Object.keys(LOCALE_LABELS) as DocSearchLocale[]).map((code) => (
                  <option key={code} value={code}>
                    {LOCALE_LABELS[code]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={close}
                aria-label={copy.close}
                className="shrink-0 rounded p-1 text-docs-text-muted transition hover:text-docs-text"
              >
                <XIcon className="size-4" />
              </button>
            </div>

            <div id="docs-search-results" role="listbox" aria-label={copy.dialogLabel} className="overflow-y-auto">
              {display.kind === 'results' ? (
                hits.map((result, index) => (
                  <Link
                    key={`${result.slug}${result.anchor}`}
                    ref={(node: HTMLAnchorElement | null) => {
                      optionRefs.current[index] = node
                    }}
                    id={`docs-search-hit-${index}`}
                    role="option"
                    aria-selected={index === selected}
                    href={result.url}
                    onClick={() => setOpen(false)}
                    onMouseEnter={() => setSelected(index)}
                    className={`block border-b border-docs-border px-4 py-3 no-underline last:border-b-0 ${
                      index === selected ? 'bg-docs-accent-tint' : ''
                    }`}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-docs-heading">
                        {result.heading}
                      </span>
                      <span className="docs-mono shrink-0 text-[0.7rem] text-docs-text-muted">
                        {result.docTitle}
                      </span>
                    </div>
                    {result.snippet && (
                      <p className="mt-1 line-clamp-2 text-[0.8rem] leading-relaxed text-docs-text-secondary">
                        {result.snippet}
                      </p>
                    )}
                  </Link>
                ))
              ) : (
                <p className="px-4 py-8 text-center text-sm text-docs-text-muted">
                  {statusMessage(display.kind, copy)}
                </p>
              )}
            </div>

            <div className="flex items-center gap-3 border-t border-docs-border px-4 py-2 text-[0.7rem] text-docs-text-muted">
              <span className="docs-mono">↑↓ ⏎</span>
              <span>{copy.hint}</span>
              <span className="docs-mono ml-auto">esc</span>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
