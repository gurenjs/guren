import { Router, requireVerifiedEmail } from '@guren/core'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { ProfileUpdateSchema } from '../app/Http/Validators/ProfileValidator.js'

// Signing in, registering, resetting a password, verifying an email and
// OAuth live in modules/auth (RFC 0002) — see modules/auth/routes/index.ts.
// This registrar keeps only the authenticated-area routes that are not auth
// itself.
export function registerAuthenticatedAreaRoutes(router: Router<'auth'>): void {
  router.middleware('auth').group((authed) => {
    authed
      .get('/dashboard', [DashboardController, 'index'], requireVerifiedEmail({ redirectTo: '/verify-email' }))
      .name('dashboard')
    authed.get('/profile', { name: 'profile.edit' }, [ProfileController, 'edit'])
    authed.put('/profile', { name: 'profile.update', body: ProfileUpdateSchema }, [ProfileController, 'update'])
    authed.patch('/profile', { name: 'profile.patch', body: ProfileUpdateSchema }, [ProfileController, 'update'])
  })
}
