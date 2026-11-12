import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { Controller } from '../../src/mvc/Controller'

class PostController extends Controller {
  static readonly methods: string[] = []

  show() {
    PostController.methods.push(this.request.method)
    return this.text('post')
  }
}

// The controllers guide tells an action that writes to read `this.request.method`:
// hono answers a HEAD with the GET route's handler and drops the body.
describe('a GET action on a HEAD request', () => {
  test('should run, and read HEAD as the request method', async () => {
    const app = new Hono()
    app.get('/posts/1', (c) => {
      const controller = new PostController()
      controller.setContext(c)
      return controller.show()
    })

    const response = await app.request('/posts/1', { method: 'HEAD' })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(PostController.methods).toEqual(['HEAD'])
  })
})
