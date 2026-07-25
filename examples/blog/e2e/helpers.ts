import type { Page } from '@playwright/test'

// Auth pages use plain controlled inputs (no useForm()), so filling a field
// before Inertia's client hydration completes can get clobbered by React's
// hydration reconciliation. Layout.tsx exposes data-hydrated for this.
export async function gotoHydrated(page: Page, path: string) {
  await page.goto(path)
  await page.waitForSelector('main[data-hydrated="true"]')
}
