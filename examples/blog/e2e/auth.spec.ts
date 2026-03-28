import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('Email address').fill('demo@guren.dev')
  await page.getByLabel('Password').fill('secret')

  // Listen for navigation response to debug login issues
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL('**/dashboard', { timeout: 15_000 })

}

test.describe('Authentication', () => {
  test.describe.configure({ mode: 'serial' })

  test('login page renders the sign-in form', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible()
    await expect(page.getByLabel('Email address')).toBeVisible()
    await expect(page.getByLabel('Password')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  test('login with valid credentials redirects to dashboard', async ({ page }) => {
    await login(page)

    await expect(page).toHaveURL('/dashboard')
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Demo User')).toBeVisible()
  })

  test('authenticated user can log out', async ({ page }) => {
    await login(page)

    // Log out — Inertia <Link method="post" as="button"> fires an XHR.
    // LoginController.destroy redirects to '/'.
    await page.getByRole('button', { name: 'Log out' }).click()
    await page.waitForURL('/', { timeout: 10_000 })

    await expect(page).toHaveURL('/')
  })

  test('visiting /dashboard without auth redirects to /login', async ({ page }) => {
    await page.goto('/dashboard')

    await expect(page).toHaveURL(/\/login/)
  })

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')

    await page.getByLabel('Email address').fill('wrong@example.com')
    await page.getByLabel('Password').fill('wrongpassword')
    await page.getByRole('button', { name: 'Sign in' }).click()

    // Native form POST — wait for the server round-trip and page reload
    await page.waitForLoadState('networkidle')

    // Should stay on login page and show an error
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByText('Invalid credentials')).toBeVisible({ timeout: 10_000 })
  })
})
