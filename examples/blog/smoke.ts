import { createTestClient, PendingTestResponse } from '@guren/testing'
import app, { ready } from './src/main.ts'

// A missing database is the one boot failure worth skipping: contributors run
// this without postgres up. Anything else is a regression the smoke must fail.
const CONNECTIVITY_ERROR =
  /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|cannot connect to the database/i

async function main() {
  try {
    await ready
  } catch (error) {
    if (CONNECTIVITY_ERROR.test(String(error))) {
      console.warn('Skipping smoke test: database is not reachable.', error)
      return
    }
    throw error
  }

  // createTestClient's default base URL is http://localhost, which src/app.ts
  // host authorization admits outside production.
  const client = createTestClient((request) => app.fetch(request))

  // data-server-rendered is Inertia's SSR marker; the client-side fallback
  // shell ships an empty <div id="app"></div> without it.
  const root = await client.get('/').send()
  root.assertStatus(200)
  await root.assertBodyContains('data-server-rendered="true"')

  await new PendingTestResponse(client.get('/posts').asInertia().acceptJson().send())
    .assertOk()
    .assertInertia('posts/Index')

  console.log('Smoke test passed: SSR HTML and JSON endpoints responded successfully')
}

await main()

// The booted app holds live handles (DB pool, scheduler), so it never exits alone.
process.exit(0)
