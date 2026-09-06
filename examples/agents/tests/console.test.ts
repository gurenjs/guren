import { beforeAll, describe, expect, test } from 'bun:test'

import type { TestApp } from '@guren/testing'

import { operatorToken, parkApproval, testApp } from './support/app'

let http: TestApp
let token: string

/** What Inertia's own transport sends; without it a refusal renders as JSON 422. */
const INERTIA = { 'X-Inertia': 'true', Referer: '/login' }

beforeAll(async () => {
  http = await testApp()
  token = await operatorToken('Console Operator')
})

/** The cookies a response set, as a browser would carry them into the next request. */
function jarOf(response: Response): string {
  const jar = new Map<string, string>()
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair] = setCookie.split(';')
    const at = pair!.indexOf('=')
    if (at > 0) jar.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim())
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** A signed-in browser: the console's session cookie plus the XSRF header Inertia sends. */
async function signedIn(): Promise<TestApp> {
  const priming = await (await http.withCsrf('/login')).post('/login', { token })
  const cookie = jarOf(priming.raw)
  const xsrf = /XSRF-TOKEN=([^;]+)/u.exec(cookie)![1]!
  return http.withHeaders({ Cookie: cookie, 'X-XSRF-TOKEN': decodeURIComponent(xsrf) })
}

describe('console session', () => {
  test('should send an anonymous visitor to the login page', async () => {
    await http.get('/').assertRedirect('/login')
  })

  test('should render the login page', async () => {
    const body = await (await http.get('/login').assertOk()).text()
    expect(body).toContain('"component":"Login"')
  })

  test('should refuse a token that is not live', async () => {
    const primed = await http.withCsrf('/login')
    // 303 back to the page with the message flashed — the shape an Inertia
    // request gets. Without `X-Inertia` the same throw renders as a JSON 422.
    await primed
      .withHeaders(INERTIA)
      .post('/login', { token: 'guren_nope_nothingatall' })
      .assertRedirect('/login')
  })

  test('should sign in with the seeded operator token and render the console', async () => {
    const browser = await signedIn()
    const body = await (await browser.get('/').assertOk()).text()

    expect(body).toContain('"component":"Console"')
    expect(body).toContain('Console Operator')
  })
})

describe('console csrf', () => {
  /**
   * The console is the one cookie-carrying surface, so it is the one the CSRF
   * middleware defends. `routes/api.ts` stays exempt on its own terms
   * (`isBearerRequestWithoutCookies`), which every test in operator-api.test.ts
   * exercises by POSTing with a bearer header and no cookies.
   */
  test('should refuse a console mutation that carries no XSRF token', async () => {
    const browser = await signedIn()
    await browser.withHeaders({ 'X-XSRF-TOKEN': '' }).post('/console/sweep', {}).assertStatus(403)
    // The same request with the token reaches the action, which refuses for its
    // own reason (no Durable Object under Bun) — so the 403 above is CSRF's.
    await browser.post('/console/sweep', {}).assertStatus(422)
  })

  test('should answer an approval from the console and redirect back', async () => {
    const browser = await signedIn()
    const { id } = await parkApproval({ id: 4242 })

    await browser.post(`/console/approvals/${id}/approve`, {}).assertRedirect('/')
    // The console records the operator's name, not a bare id: `operatorName` is
    // one rule over two guards, and only this half resolves a whole user row.
    const listing = await (
      await http.withHeaders({ Authorization: `Bearer ${token}` }).get('/approvals').assertOk()
    ).json<{ resolved: Array<{ id: string; resolvedBy: string }> }>()
    expect(listing.resolved.find((row) => row.id === id)?.resolvedBy).toBe('Console Operator')
    // A second answer is refused for the reason the JSON API refuses one, only
    // flashed onto the page instead of carrying a status code of its own.
    await browser
      .withHeaders({ ...INERTIA, Referer: '/' })
      .post(`/console/approvals/${id}/reject`, {})
      .assertRedirect('/')
  })
})
