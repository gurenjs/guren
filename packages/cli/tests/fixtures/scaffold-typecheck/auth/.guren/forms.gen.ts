// Companion for typechecking templates/scaffold/auth (tsconfig.templates.json): the contracts
// `guren codegen` writes for the two static auth pages, with each body type spelled out in
// place of the `ApiRoutes` entry, since this fixture app has no api-client.gen.ts.
import type { RouteFormContract } from '@guren/inertia-client/forms'

export const forgotPasswordStoreForm: RouteFormContract<'forgot-password.store', 'POST', '/forgot-password', { email: string }> = {
  route: 'forgot-password.store',
  method: 'POST',
  path: '/forgot-password',
  fields: {
    email: { type: 'string', required: true, format: 'email', minLength: 1 },
  },
}

export const resetPasswordStoreForm: RouteFormContract<'reset-password.store', 'POST', '/reset-password', { token: string; password: string; passwordConfirmation: string }> = {
  route: 'reset-password.store',
  method: 'POST',
  path: '/reset-password',
  fields: {
    token: { type: 'string', required: true, minLength: 1 },
    password: { type: 'string', required: true, minLength: 8 },
    passwordConfirmation: { type: 'string', required: true, minLength: 1 },
  },
}
