import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

  router.get('/', [PostController, 'index']).name('home')

  router.middleware('guest').get('/login', [LoginController, 'show']).name('login')
  router.post('/login', { name: 'login.store' }, [LoginController, 'store'])
  router.middleware('auth').post('/logout', [LoginController, 'destroy']).name('logout')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.middleware('auth').get('/new', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.middleware('auth').group((authed) => {
      authed.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
      authed.post('/', [PostController, 'store']).name('posts.store')
      authed.put('/:id', { bind: { id: Post }, name: 'posts.update' }, [PostController, 'update'])
      authed.patch('/:id', { bind: { id: Post }, name: 'posts.patch' }, [PostController, 'update'])
    })
  })

  router.middleware('auth').group((authed) => {
    authed.get('/dashboard', [DashboardController, 'index']).name('dashboard')
    authed.get('/profile', [ProfileController, 'edit']).name('profile.edit')
    authed.put('/profile', [ProfileController, 'update']).name('profile.update')
    authed.patch('/profile', [ProfileController, 'update']).name('profile.patch')
  })
}
