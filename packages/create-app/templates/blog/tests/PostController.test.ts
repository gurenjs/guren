import { beforeAll, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'

// posts.search is an HTTP QUERY route (RFC 10008). Its controller validates
// the body with validateBody() before building any query — the schema bound
// to the route feeds codegen and `guren audit`, while body parsing stays in
// the controller so the request stream is read once — so an invalid payload
// gets a 422 without the database ever being touched. That keeps this starter
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
