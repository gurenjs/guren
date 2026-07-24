import { Router, requireVerifiedEmail } from '@guren/core'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import ForgotPasswordController from '../app/Http/Controllers/Auth/ForgotPasswordController.js'
import ResetPasswordController from '../app/Http/Controllers/Auth/ResetPasswordController.js'
import VerifyEmailController from '../app/Http/Controllers/Auth/VerifyEmailController.js'
import OAuthController from '../app/Http/Controllers/Auth/OAuthController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { ForgotPasswordSchema } from '../app/Http/Validators/ForgotPasswordValidator.js'
import { ResetPasswordSchema } from '../app/Http/Validators/ResetPasswordValidator.js'
import { ProfileUpdateSchema } from '../app/Http/Validators/ProfileValidator.js'

// Relies on the 'auth'/'guest' aliases the caller (routes/web.ts) has
// already registered on this router via aliasMiddleware() — reusing them
// (via .group(), not direct .middleware(name).post() chaining, since the
// latter's RouterMiddlewareGroupBuilder doesn't support the
// [Controller, 'method'] tuple + typed body-schema combination) keeps this
// middleware visible to `guren audit`'s static route inspection, unlike
// passing requireAuthenticated()/requireGuest() call results inline.
export function registerAuthRoutes(router: Router<'auth' | 'guest'>): void {
  router.middleware('guest').group((guest) => {
    guest.get('/login', { name: 'login' }, [LoginController, 'show'])
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])

    guest.get('/register', { name: 'register' }, [RegisterController, 'show'])
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])

    guest.get('/forgot-password', { name: 'forgot-password' }, [ForgotPasswordController, 'show'])
    guest.post('/forgot-password', { name: 'forgot-password.store', body: ForgotPasswordSchema }, [ForgotPasswordController, 'store'])
    guest.get('/reset-password', { name: 'reset-password' }, [ResetPasswordController, 'show'])
    guest.post('/reset-password', { name: 'reset-password.store', body: ResetPasswordSchema }, [ResetPasswordController, 'store'])

    guest.get('/auth/:provider', { name: 'oauth.redirect' }, [OAuthController, 'redirectToProvider'])
  })

  router.middleware('auth').group((authed) => {
    authed.post('/logout', { name: 'logout' }, [LoginController, 'destroy'])

    authed.get('/verify-email', { name: 'verify-email' }, [VerifyEmailController, 'notice'])
    authed.post('/verify-email', { name: 'verify-email.resend' }, [VerifyEmailController, 'resend'])
    authed.get('/verify-email/confirm', { name: 'verify-email.confirm' }, [VerifyEmailController, 'confirm'])

    authed
      .get('/dashboard', [DashboardController, 'index'], requireVerifiedEmail({ redirectTo: '/verify-email' }))
      .name('dashboard')
    authed.get('/profile', { name: 'profile.edit' }, [ProfileController, 'edit'])
    authed.put('/profile', { name: 'profile.update', body: ProfileUpdateSchema }, [ProfileController, 'update'])
    authed.patch('/profile', { name: 'profile.patch', body: ProfileUpdateSchema }, [ProfileController, 'update'])
  })

  // Public: the OAuth provider redirects here directly, before any session exists.
  router.get('/auth/:provider/callback', { name: 'oauth.callback' }, [OAuthController, 'callback'])
}
