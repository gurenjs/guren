import { Router, requireVerifiedEmail } from '@guren/core'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { ProfileUpdateSchema } from '../app/Http/Validators/ProfileValidator.js'

// Auth itself (sign-in, registration, password reset, OAuth) is modules/auth.
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
