import { Route, requireAuthenticated, requireGuest } from '@guren/server'
import PostController from '../app/Http/Controllers/PostController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'

Route.get('/', [PostController, 'index']).name('home')

Route.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
Route.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')
Route.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')

Route.group('/posts', () => {
  Route.get('/', [PostController, 'index']).name('posts.index')
  Route.get('/new', [PostController, 'create']).name('posts.create')
  Route.get('/:id', [PostController, 'show']).name('posts.show')
  Route.get('/:id/edit', [PostController, 'edit']).name('posts.edit')
  Route.post('/', [PostController, 'store']).name('posts.store')
  Route.put('/:id', [PostController, 'update']).name('posts.update')
  Route.patch('/:id', [PostController, 'update']).name('posts.patch')
})

Route.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
Route.get('/profile', [ProfileController, 'edit'], requireAuthenticated({ redirectTo: '/login' })).name('profile.edit')
Route.put('/profile', [ProfileController, 'update'], requireAuthenticated({ redirectTo: '/login' })).name('profile.update')
Route.patch('/profile', [ProfileController, 'update'], requireAuthenticated({ redirectTo: '/login' })).name('profile.patch')
