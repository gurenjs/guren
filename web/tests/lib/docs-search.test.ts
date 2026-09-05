import { describe, expect, it, vi } from 'vitest'

import {
  createDebouncedDocSearch,
  createDocSearchRunner,
  MAX_QUERY_LENGTH,
  type DocSearchHit,
  type DocSearchOutcome,
} from '../../resources/js/lib/docs-search.js'

function hit(slug: string): DocSearchHit {
  return {
    category: 'guides',
    slug,
    anchor: 'a',
    docTitle: slug,
    heading: 'Heading',
    snippet: 'Snippet',
    url: `/docs/guides/${slug}`,
  }
}

function jsonResponse(hits: DocSearchHit[], status = 200): Response {
  return new Response(JSON.stringify({ results: hits }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A fetch whose responses are released by hand, so a test can make the first
 * request resolve *after* the second — the ordering the network actually
 * produces and the reason this module exists.
 */
function deferredFetch(options: { ignoreAbort?: boolean } = {}) {
  const releases: Array<(response: Response) => void> = []
  const urls: string[] = []

  const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url))
    return new Promise<Response>((resolve, reject) => {
      releases.push(resolve)
      // `ignoreAbort` models a response that was already buffered when the
      // abort landed: aborting does not reject it, so a superseded call
      // arrives intact and only the token comparison can discard it.
      if (!options.ignoreAbort) {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      }
    })
  })

  return { fetch: fetchMock as unknown as typeof globalThis.fetch, releases, urls, calls: fetchMock }
}

describe('createDocSearchRunner', () => {
  it('sends the query and locale to the search endpoint', async () => {
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('コントローラー', 'ja')
    deferred.releases[0](jsonResponse([hit('controllers')]))

    expect(await pending).toEqual({ status: 'ok', hits: [hit('controllers')] })
    expect(deferred.urls[0]).toBe(
      `/docs/search?q=${encodeURIComponent('コントローラー')}&locale=ja`,
    )
  })

  it('discards a response that arrives after a newer query', async () => {
    // The failure this guards: 「認」is slow, 「認証」is fast, and without the
    // check the reader watches their results revert as they type.
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const stale = runner.run('認', 'ja')
    const fresh = runner.run('認証', 'ja')

    deferred.releases[1](jsonResponse([hit('authentication')]))
    deferred.releases[0](jsonResponse([hit('stale')]))

    expect(await fresh).toEqual({ status: 'ok', hits: [hit('authentication')] })
    expect(await stale).toBeNull()
  })

  it('reports a superseded request as nothing rather than as a failure', async () => {
    // Superseding aborts the previous fetch, so it rejects. Surfacing that as
    // an error would flash a failure message on every keystroke.
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const stale = runner.run('rou', 'en')
    const fresh = runner.run('routing', 'en')
    deferred.releases[1](jsonResponse([hit('routing')]))

    expect(await stale).toBeNull()
    expect(await fresh).toMatchObject({ status: 'ok' })
  })

  it('reports an explicit cancel as nothing rather than as a failure', async () => {
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('routing', 'en')
    runner.cancel()

    expect(await pending).toBeNull()
  })

  it('discards a cancelled response the abort did not reject', async () => {
    // Clearing the input cancels without starting a newer search. If the
    // response was already buffered the abort does not reject it, and the
    // results would repaint under an input the reader has just emptied.
    const deferred = deferredFetch({ ignoreAbort: true })
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('routing', 'en')
    runner.cancel()
    deferred.releases[0](jsonResponse([hit('routing')]))

    expect(await pending).toBeNull()
  })

  it('distinguishes an unbuilt index from a failure', async () => {
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('routing', 'en')
    deferred.releases[0](new Response('{}', { status: 503 }))

    expect(await pending).toEqual({ status: 'unavailable' })
  })

  it('discards a superseded response the abort did not reject', async () => {
    const deferred = deferredFetch({ ignoreAbort: true })
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const stale = runner.run('rou', 'en')
    const fresh = runner.run('routing', 'en')

    deferred.releases[1](jsonResponse([hit('routing')]))
    deferred.releases[0](jsonResponse([hit('stale')]))

    expect(await stale).toBeNull()
    expect(await fresh).toEqual({ status: 'ok', hits: [hit('routing')] })
  })

  it('does not let a superseded failure paint over the current query', async () => {
    // A stale 503 reaching the display would tell the reader the index is not
    // built while their actual query is answering fine.
    const deferred = deferredFetch({ ignoreAbort: true })
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const stale = runner.run('rou', 'en')
    const fresh = runner.run('routing', 'en')

    deferred.releases[1](jsonResponse([hit('routing')]))
    deferred.releases[0](new Response('{}', { status: 503 }))

    expect(await stale).toBeNull()
    expect(await fresh).toMatchObject({ status: 'ok' })
  })

  it('discards a response superseded while its body was being read', async () => {
    // The narrow window the second comparison covers: the status was current
    // when it was checked, and the reader typed again while json() ran.
    let resolveBody: (value: unknown) => void = () => {}
    const body = new Promise((resolve) => {
      resolveBody = resolve
    })
    const deferred = deferredFetch({ ignoreAbort: true })
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const stale = runner.run('rou', 'en')
    deferred.releases[0]({
      ok: true,
      status: 200,
      json: () => body,
    } as unknown as Response)
    await Promise.resolve()

    const fresh = runner.run('routing', 'en')
    resolveBody({ results: [hit('stale')] })
    deferred.releases[1](jsonResponse([hit('routing')]))

    expect(await stale).toBeNull()
    expect(await fresh).toEqual({ status: 'ok', hits: [hit('routing')] })
  })

  it('distinguishes being rate limited from a failure', async () => {
    // The reader is told to wait rather than to try again, which is what the
    // generic failure message invites.
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('routing', 'en')
    deferred.releases[0](new Response('{}', { status: 429 }))

    expect(await pending).toEqual({ status: 'throttled' })
  })

  it('reports a server failure', async () => {
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('routing', 'en')
    deferred.releases[0](new Response('{}', { status: 500 }))

    expect(await pending).toEqual({ status: 'error' })
  })

  it('reports a network failure', async () => {
    const runner = createDocSearchRunner({
      fetch: (() => Promise.reject(new TypeError('offline'))) as unknown as typeof globalThis.fetch,
    })

    expect(await runner.run('routing', 'en')).toEqual({ status: 'error' })
  })

  it('truncates rather than sending a query the route would reject', async () => {
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    void runner.run('a'.repeat(MAX_QUERY_LENGTH + 20), 'en')

    expect(deferred.urls[0]).toBe(`/docs/search?q=${'a'.repeat(MAX_QUERY_LENGTH)}&locale=en`)
  })

  it('treats a response with no results array as empty', async () => {
    const deferred = deferredFetch()
    const runner = createDocSearchRunner({ fetch: deferred.fetch })

    const pending = runner.run('routing', 'en')
    deferred.releases[0](new Response('{}', { status: 200 }))

    expect(await pending).toEqual({ status: 'ok', hits: [] })
  })
})

describe('createDebouncedDocSearch', () => {
  function runnerSpy(outcome: DocSearchOutcome = { status: 'ok', hits: [] }) {
    const run = vi.fn(async () => outcome)
    const cancel = vi.fn()
    return { runner: { run, cancel }, run, cancel }
  }

  it('collapses a burst of typing into one request', async () => {
    // `/docs/search` is rate limited; one request per keystroke would have the
    // UI trip a limit that exists to stop abuse.
    vi.useFakeTimers()
    const spy = runnerSpy()
    const search = createDebouncedDocSearch({ runner: spy.runner, delayMs: 150 })

    for (const query of ['r', 'ro', 'rou', 'rout', 'routing']) {
      search.schedule(query, 'en', () => {})
    }
    await vi.advanceTimersByTimeAsync(200)

    expect(spy.run).toHaveBeenCalledTimes(1)
    expect(spy.run).toHaveBeenCalledWith('routing', 'en')
    vi.useRealTimers()
  })

  it('delivers the outcome once the delay elapses', async () => {
    vi.useFakeTimers()
    const spy = runnerSpy({ status: 'ok', hits: [hit('routing')] })
    const search = createDebouncedDocSearch({ runner: spy.runner, delayMs: 150 })
    const deliver = vi.fn()

    search.schedule('routing', 'en', deliver)
    expect(deliver).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    expect(deliver).toHaveBeenCalledWith({ status: 'ok', hits: [hit('routing')] })
    vi.useRealTimers()
  })

  it('never delivers a superseded outcome', async () => {
    vi.useFakeTimers()
    const spy = runnerSpy()
    spy.run.mockResolvedValue(null as unknown as DocSearchOutcome)
    const search = createDebouncedDocSearch({ runner: spy.runner, delayMs: 150 })
    const deliver = vi.fn()

    search.schedule('routing', 'en', deliver)
    await vi.advanceTimersByTimeAsync(200)

    expect(deliver).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('retires a running request when a newer query is scheduled', async () => {
    // Clearing only the timer leaves the in-flight request holding the current
    // token for the debounce interval — long enough to deliver its rows into
    // the loading state of a query the reader had moved on from.
    vi.useFakeTimers()
    const spy = runnerSpy()
    const search = createDebouncedDocSearch({ runner: spy.runner, delayMs: 150 })

    search.schedule('old', 'en', () => {})
    await vi.advanceTimersByTimeAsync(200)
    expect(spy.run).toHaveBeenCalledTimes(1)

    search.schedule('new', 'en', () => {})
    expect(spy.cancel).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('cancels a queued search and the request behind it', async () => {
    vi.useFakeTimers()
    const spy = runnerSpy()
    const search = createDebouncedDocSearch({ runner: spy.runner, delayMs: 150 })

    search.schedule('routing', 'en', () => {})
    search.cancel()
    await vi.advanceTimersByTimeAsync(200)

    expect(spy.run).not.toHaveBeenCalled()
    expect(spy.cancel).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
