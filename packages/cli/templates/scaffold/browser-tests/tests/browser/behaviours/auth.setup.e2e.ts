import { test } from '@e2e-dev/web'
import { credentials, expect } from 'e2e'

type InitialPage = { component?: unknown } | null

// The labels are the ones `guren make:auth` writes into resources/js/pages/auth/Login.tsx; edit them with the page.
// No agent step: the runner types the credential itself, and nothing here is recorded.
test.setup('sign in as the browser account', { sessions: ['browser'] }, async ({ screen, session, browser }) => {
  let account: ReturnType<typeof credentials.user>
  try {
    account = credentials.user('browser')
  } catch {
    // A setup test cannot skip; failing here makes the runner skip every test that needs the session.
    throw new Error('Set BROWSER_TEST_PASSWORD (six characters or more) in .env: the browser account is seeded with it, and nothing signs in without it.')
  }
  // Filled before React hydrates, the form is reset to empty by hydration and submits nothing.
  await browser.goto('/login', { waitUntil: 'networkidle' })
  await screen.getByLabel('Email').fill(account.username)
  await screen.getByLabel('Password').fill(account.password)
  await screen.getByRole('button', 'Sign in').tap()
  await expect(browser).not.toHaveURL(/\/login(?:[?#]|$)/u)
  // A fresh load, so the initial page names where the sign-in landed: an auth page (verify email, two factors) is no session to save.
  await browser.reload()
  const component = await browser.evaluate(() => {
    let initial = (window as Window & { __INERTIA_PAGE__?: InitialPage }).__INERTIA_PAGE__
    if (!initial) {
      try {
        initial = JSON.parse(document.querySelector('script[data-page="app"][type="application/json"]')?.textContent ?? 'null') as InitialPage
      } catch {
        initial = null
      }
    }
    return typeof initial?.component === 'string' ? initial.component : null
  })
  if (component?.startsWith('auth/')) throw new Error(`the sign-in landed on ${component}, which is no session to save: finish that step for the browser account in db/seeders/browser-account.ts`)
  // The server reads a locale cookie ahead of the config's locale, so one set at sign-in would carry into every signed-in test.
  // `locale` is the name unless createApp({ i18n: { detect: { cookieName } } }) renames it.
  await browser.clearCookies({ name: 'locale' })
  await session.save('browser')
})
