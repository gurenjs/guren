import type { Browser, WebApp } from '@e2e-dev/web'

/** What an entry gets: the test's own `app` and `browser`, signed in when the test is. */
export interface GivenFixtures {
  app: WebApp
  browser: Browser
}

/**
 * Read by tests/browser/behaviours/generated/. One entry per behaviour that needs data or a path parameter.
 * Use locators only: an agent step here would be recorded under the test that calls it.
 */
export const given: Record<string, (fixtures: GivenFixtures) => Promise<Record<string, string> | void>> = {
  // 'AC-comments-store-1': async () => ({ post: '1' }),   // the values of the start page's path parameters
}
