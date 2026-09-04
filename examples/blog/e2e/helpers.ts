import type { Page } from '@playwright/test'

// React's hydration reconciliation clobbers input typed before it finishes, so
// wait on Layout.tsx's data-hydrated after navigating to an interactive page.
export async function waitForHydrated(page: Page) {
  await page.waitForSelector('main[data-hydrated="true"]')
}

export async function gotoHydrated(page: Page, path: string) {
  await page.goto(path)
  await waitForHydrated(page)
}
