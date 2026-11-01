// Generated — DO NOT EDIT
// Run `guren codegen` to regenerate.
import type { RouteFormContract } from '@guren/inertia-client/forms'
import type { ApiRoutes } from './api-client.gen'

export const loginStoreForm: RouteFormContract<'login.store', 'POST', '/login', ApiRoutes['login.store']['body']> = {
  route: 'login.store',
  method: 'POST',
  path: '/login',
  fields: {
    email: { type: 'string', required: true, minLength: 1 },
    password: { type: 'string', required: true, minLength: 1 },
    remember: { type: 'unknown', required: false },
  },
}

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

export const profileUpdateForm: RouteFormContract<'profile.update', 'PUT', '/profile', ApiRoutes['profile.update']['body']> = {
  route: 'profile.update',
  method: 'PUT',
  path: '/profile',
  fields: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    email: { type: 'string', required: true, minLength: 1 },
    password: { type: 'string', required: false },
  },
}

export const registerStoreForm: RouteFormContract<'register.store', 'POST', '/register', ApiRoutes['register.store']['body']> = {
  route: 'register.store',
  method: 'POST',
  path: '/register',
  fields: {
    name: { type: 'string', required: true, minLength: 1, maxLength: 120 },
    email: { type: 'string', required: true, minLength: 1 },
    password: { type: 'string', required: true, minLength: 8 },
    passwordConfirmation: { type: 'string', required: true, minLength: 1 },
  },
}
