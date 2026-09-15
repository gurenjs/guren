import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// posts.search is an HTTP QUERY route (RFC 10008). The body schema bound to the
// route is validated before the controller runs, and the same schema feeds
// codegen and `guren audit`.

// So an invalid payload gets a 422 without the database ever being touched,
// which keeps this starter test green without migrations or fixtures. Cover the
// happy path with real feature tests once your test database is set up.
describe('posts.search', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('rejects a search without keywords', async () => {
    await http.query('/posts/search', { keywords: [] }).assertStatus(422)
  })
})
