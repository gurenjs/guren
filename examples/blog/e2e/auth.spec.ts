import { test, expect, type Page } from '@playwright/test'

async function login(page: Page) {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible()
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()
  const emailInput = page.getByLabel('Email address')
  const passwordInput = page.getByLabel('Password')
  await emailInput.click()
  await emailInput.pressSequentially('demo@guren.dev')
  await expect(emailInput).toHaveValue('demo@guren.dev')
  await passwordInput.click()
  await passwordInput.pressSequentially('secret')
  await expect(passwordInput).toHaveValue('secret')

  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test.describe('Authentication', () => {
  test.describe.configure({ mode: 'serial' })

  test('login page renders the sign-in form', async ({ page }) => {
    await page.goto('/login')

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

    await Promise.all([
      page.waitForURL('**/'),
      page.getByRole('button', { name: 'Log out' }).click(),
    ])

    await expect(page).toHaveURL('/')
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  })

  test('visiting /dashboard without auth redirects to /login', async ({ page }) => {
    await page.goto('/dashboard')

    await expect(page).toHaveURL(/\/login/)
  })

  test('login with invalid credentials shows error', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible()
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible()

    const emailInput = page.getByLabel('Email address')
    const passwordInput = page.getByLabel('Password')
    await emailInput.click()
    await emailInput.pressSequentially('wrong@example.com')
    await expect(emailInput).toHaveValue('wrong@example.com')
    await passwordInput.click()
    await passwordInput.pressSequentially('wrongpassword')
    await expect(passwordInput).toHaveValue('wrongpassword')
    await page.getByRole('button', { name: 'Sign in' }).click()

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByText('Invalid credentials')).toBeVisible()
  })

  test('protected routes redirect unauthenticated users', async ({ page }) => {
    await page.goto('/posts/new')
    await expect(page).toHaveURL(/\/login/)

    await page.goto('/posts/1/edit')
    await expect(page).toHaveURL(/\/login/)

    await page.goto('/profile')
    await expect(page).toHaveURL(/\/login/)
  })
})
