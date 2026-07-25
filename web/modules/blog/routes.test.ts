import { Buffer } from 'node:buffer'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TestApp } from '@guren/testing'
import type { Router } from '@guren/core'
import { registerBlogRoutes } from './routes.js'

const originalAppKey = process.env.APP_KEY

beforeAll(() => {
  // Session middleware requires a signing key; any 32-byte value works here.
  process.env.APP_KEY ??= Buffer.alloc(32, 7).toString('base64')
})

afterAll(() => {
  if (originalAppKey === undefined) {
    delete process.env.APP_KEY
  } else {
    process.env.APP_KEY = originalAppKey
  }
})

async function createBlogTestApp(): Promise<TestApp> {
  return TestApp.create({
    routes: (router) => {
      registerBlogRoutes(router as Router)
    },
    auth: { autoSession: true },
  })
}

describe('admin route guard', () => {
  it('should redirect unauthenticated requests to /auth/github', async () => {
    const app = await createBlogTestApp()

    await app.get('/admin').assertRedirect('/auth/github')
  })

  it('should leave the public blog index unguarded', async () => {
    const app = await createBlogTestApp()

    // No auth redirect: the request reaches the controller (which may then
    // fail on the unconfigured test database — anything but a redirect
    // proves the route is not behind the guard).
    const response = await app.get('/blog')
    expect(response.status).not.toBe(302)
  })
})
