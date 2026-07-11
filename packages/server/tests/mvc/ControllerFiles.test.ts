import { describe, test, expect } from 'bun:test'
import { Hono } from 'hono'
import { Controller } from '../../src/mvc/Controller'

class UploadController extends Controller {
  async single() {
    const file = await this.file('document')
    if (!file) {
      return this.json({ file: null })
    }
    return this.json({ file: { name: file.name, size: file.size, content: await file.text() } })
  }

  async multiple() {
    const files = await this.files('documents')
    return this.json({ count: files.length, names: files.map((file) => file.name) })
  }

  async mixed() {
    const file = await this.file('document')
    const body = await this.ctx.req.parseBody()
    return this.json({ hasFile: file !== null, title: body.title ?? null })
  }
}

function createApp() {
  const app = new Hono()
  for (const [path, action] of [
    ['/single', 'single'],
    ['/multiple', 'multiple'],
    ['/mixed', 'mixed'],
  ] as const) {
    app.post(path, async (c) => {
      const ctrl = new UploadController()
      ctrl.setContext(c)
      return ctrl[action]()
    })
  }
  return app
}

describe('Controller file helpers', () => {
  test('file() returns the uploaded file with its contents', async () => {
    const app = createApp()
    const form = new FormData()
    form.append('document', new File(['hello world'], 'notes.txt', { type: 'text/plain' }))

    const res = await app.request('/single', { method: 'POST', body: form })
    const json = (await res.json()) as { file: { name: string; size: number; content: string } }
    expect(json.file.name).toBe('notes.txt')
    expect(json.file.content).toBe('hello world')
  })

  test('file() returns null for a missing or non-file field', async () => {
    const app = createApp()
    const form = new FormData()
    form.append('document', 'just a string')

    const res = await app.request('/single', { method: 'POST', body: form })
    expect(((await res.json()) as { file: unknown }).file).toBeNull()
  })

  test('file() returns null for empty uploads', async () => {
    const app = createApp()
    const form = new FormData()
    form.append('document', new File([], 'empty.txt'))

    const res = await app.request('/single', { method: 'POST', body: form })
    expect(((await res.json()) as { file: unknown }).file).toBeNull()
  })

  test('files() returns every uploaded file for a multi field', async () => {
    const app = createApp()
    const form = new FormData()
    form.append('documents', new File(['a'], 'a.txt'))
    form.append('documents', new File(['b'], 'b.txt'))

    const res = await app.request('/multiple', { method: 'POST', body: form })
    const json = (await res.json()) as { count: number; names: string[] }
    expect(json.count).toBe(2)
    expect(json.names).toEqual(['a.txt', 'b.txt'])
  })

  test('file() composes with other parseBody reads in the same request', async () => {
    const app = createApp()
    const form = new FormData()
    form.append('document', new File(['x'], 'x.txt'))
    form.append('title', 'My upload')

    const res = await app.request('/mixed', { method: 'POST', body: form })
    const json = (await res.json()) as { hasFile: boolean; title: string }
    expect(json.hasFile).toBe(true)
    expect(json.title).toBe('My upload')
  })
})
