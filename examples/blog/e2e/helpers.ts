import type { Page } from '@playwright/test'

// Filling a field or clicking a React-only control before Inertia's client
// hydration completes gets clobbered (or ignored) by React's hydration
// reconciliation. Layout.tsx exposes data-hydrated for this — wait on it
// after any navigation to an interactive page.
export async function waitForHydrated(page: Page) {
  await page.waitForSelector('main[data-hydrated="true"]')
}

export async function gotoHydrated(page: Page, path: string) {
  await page.goto(path)
  await waitForHydrated(page)
}
