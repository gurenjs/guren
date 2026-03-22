import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { PostPayloadSchema, PostIdParamSchema } from '../app/Http/Validators/PostValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'
import { ProfileUpdateSchema } from '../app/Http/Validators/ProfileValidator.js'
import { Post } from '../app/Models/Post.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [PostController, 'index']).name('home')

  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
  router.post('/login', { body: LoginSchema, name: 'login.store' }, [LoginController, 'store'])
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/new', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { params: PostIdParamSchema, name: 'posts.show' }, [PostController, 'show'])
    posts.get('/:id/edit', { params: PostIdParamSchema, bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    posts.post('/', { body: PostPayloadSchema, name: 'posts.store' }, [PostController, 'store'])
    posts.put('/:id', { body: PostPayloadSchema, params: PostIdParamSchema, bind: { id: Post }, name: 'posts.update' }, [PostController, 'update'])
    posts.patch('/:id', { body: PostPayloadSchema, params: PostIdParamSchema, bind: { id: Post }, name: 'posts.patch' }, [PostController, 'update'])
  })

  router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
  router.get('/profile', [ProfileController, 'edit'], requireAuthenticated({ redirectTo: '/login' })).name('profile.edit')
  router.put('/profile', { body: ProfileUpdateSchema, name: 'profile.update' }, [ProfileController, 'update'])
  router.patch('/profile', { body: ProfileUpdateSchema, name: 'profile.patch' }, [ProfileController, 'update'])
}
