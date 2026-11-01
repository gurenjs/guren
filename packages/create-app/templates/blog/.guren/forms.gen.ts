// Generated — DO NOT EDIT
// Run `guren codegen` to regenerate.
import type { RouteFormContract } from '@guren/inertia-client/forms'
import type { ApiRoutes } from './api-client.gen'

export const postsStoreForm: RouteFormContract<'posts.store', 'POST', '/posts', ApiRoutes['posts.store']['body']> = {
  route: 'posts.store',
  method: 'POST',
  path: '/posts',
  fields: {
    title: { type: 'string', required: true, minLength: 1, maxLength: 255 },
    excerpt: { type: 'string', required: true, minLength: 1, maxLength: 500 },
    body: { type: 'string', required: true, minLength: 1 },
  },
}

export const postsUpdateForm: RouteFormContract<'posts.update', 'PUT', '/posts/:id', ApiRoutes['posts.update']['body']> = {
  route: 'posts.update',
  method: 'PUT',
  path: '/posts/:id',
  fields: {
    title: { type: 'string', required: true, minLength: 1, maxLength: 255 },
    excerpt: { type: 'string', required: true, minLength: 1, maxLength: 500 },
    body: { type: 'string', required: true, minLength: 1 },
  },
}
