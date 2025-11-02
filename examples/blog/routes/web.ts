import { Route, requireAuthenticated, requireGuest } from '@guren/server'
import PostController from '../app/Http/Controllers/PostController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import DashboardController from '../app/Http/Controllers/DashboardController.js'

Route.get('/', [PostController, 'index'])

Route.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' }))

Route.group('/posts', () => {
  Route.get('/', [PostController, 'index'])
  Route.get('/new', [PostController, 'create'])
  Route.get('/:id', [PostController, 'show'])
  Route.get('/:id/edit', [PostController, 'edit'])
  Route.post('/', [PostController, 'store'])
  Route.put('/:id', [PostController, 'update'])
  Route.patch('/:id', [PostController, 'update'])
})

Route.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
