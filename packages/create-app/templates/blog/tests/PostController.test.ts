import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// posts.search is an HTTP QUERY route (RFC 10008) whose body schema is bound
// to the route, so invalid payloads are rejected with 422 before the
// controller — and the database — is ever reached. That keeps this starter
// test green without migrations or fixtures; cover the happy path with real
// feature tests once your test database is set up.
describe('posts.search', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  it('rejects a search without keywords', async () => {
    await http.query('/posts/search', { keywords: [] }).assertStatus(422)
  })
})
