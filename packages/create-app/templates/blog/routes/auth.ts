import type { Router } from '@guren/core'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'

// Uses the 'auth' and 'guest' aliases routes/web.ts registers on this router.
export function registerAuthRoutes(router: Router<'auth' | 'guest'>): void {
  router.middleware('guest').group((guest) => {
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', [LoginController, 'store']).name('login.store')
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', [RegisterController, 'store']).name('register.store')
  })

  router.middleware('auth').group((authed) => {
    authed.post('/logout', [LoginController, 'destroy']).name('logout')
    authed.get('/dashboard', [DashboardController, 'index']).name('dashboard')
    authed.get('/profile', [ProfileController, 'edit']).name('profile.edit')
    authed.put('/profile', [ProfileController, 'update']).name('profile.update')
  })
}
