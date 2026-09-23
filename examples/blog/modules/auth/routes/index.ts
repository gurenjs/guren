import { requireAuthenticated, requireGuest, type Router } from '@guren/core'
import LoginController from '../app/Http/Controllers/LoginController.js'
import RegisterController from '../app/Http/Controllers/RegisterController.js'
import ForgotPasswordController from '../app/Http/Controllers/ForgotPasswordController.js'
import ResetPasswordController from '../app/Http/Controllers/ResetPasswordController.js'
import VerifyEmailController from '../app/Http/Controllers/VerifyEmailController.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { ForgotPasswordSchema } from '../app/Http/Validators/ForgotPasswordValidator.js'
import { ResetPasswordSchema } from '../app/Http/Validators/ResetPasswordValidator.js'
import { registerOAuthRoutes } from './oauth.js'

// defineModule's `routes` is typed `(router: Router) => void`, an
// unparameterized Router, so an alias name the root registrar set on this
// same instance (e.g. 'auth') is not in scope here at the type level —
// `.middleware('guest')` would not compile even though the name would
// resolve at runtime. Gating goes through the handler directly instead.
export function registerAuthModuleRoutes(router: Router): void {
  router.middleware(requireGuest({ redirectTo: '/dashboard' })).group((guest) => {
    guest.get('/login', { name: 'login' }, [LoginController, 'show'])
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])

    guest.get('/register', { name: 'register' }, [RegisterController, 'show'])
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])

    guest.get('/forgot-password', { name: 'forgot-password' }, [ForgotPasswordController, 'show'])
    guest.post('/forgot-password', { name: 'forgot-password.store', body: ForgotPasswordSchema }, [ForgotPasswordController, 'store'])
    guest.get('/reset-password', { name: 'reset-password' }, [ResetPasswordController, 'show'])
    guest.post('/reset-password', { name: 'reset-password.store', body: ResetPasswordSchema }, [ResetPasswordController, 'store'])
  })

  router.middleware(requireAuthenticated({ redirectTo: '/login' })).group((authed) => {
    authed.post('/logout', { name: 'logout' }, [LoginController, 'destroy'])
    authed.get('/verify-email', { name: 'verify-email' }, [VerifyEmailController, 'notice'])
    authed.post('/verify-email', { name: 'verify-email.resend' }, [VerifyEmailController, 'resend'])
  })

  registerOAuthRoutes(router)

  // Public: confirm() validates the signed token itself, so gating it behind
  // auth would strand a user opening the link on another device.
  router.get('/verify-email/confirm', { name: 'verify-email.confirm' }, [VerifyEmailController, 'confirm'])
}
