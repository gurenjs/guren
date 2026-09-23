import { describe, expect, it } from 'vitest'
import { Router } from '@guren/core'
import { registerAuthModuleRoutes } from '../routes/index.js'

// The guards are aliased inside the module, so nothing outside it would notice
// a route losing one; the definitions carry what each chain enforces.
function authenticationByName(): Map<string, string | undefined> {
  const router = new Router()
  registerAuthModuleRoutes(router)
  return new Map(
    router.definitions().map((route) => [route.name ?? `${route.method} ${route.path}`, route.capabilities?.authentication?.mode]),
  )
}

describe('auth module routes', () => {
  const modes = authenticationByName()

  it.each([
    'login',
    'login.store',
    'register',
    'register.store',
    'forgot-password',
    'forgot-password.store',
    'reset-password',
    'reset-password.store',
    'oauth.redirect',
  ])('%s is guest-only', (name) => {
    expect(modes.get(name)).toBe('guest-only')
  })

  it.each(['logout', 'verify-email', 'verify-email.resend'])('%s requires authentication', (name) => {
    expect(modes.get(name)).toBe('required')
  })

  it.each(['oauth.callback', 'verify-email.confirm'])('%s is public', (name) => {
    expect(modes.has(name)).toBe(true)
    expect(modes.get(name)).toBeUndefined()
  })
})
