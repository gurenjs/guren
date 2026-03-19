import {
  Route,
  createRateLimitMiddleware,
  createBearerTokenMiddleware,
  MemoryRateLimitStore,
} from '@guren/server'
import AuthController, { tokenStore } from '../app/Http/Controllers/AuthController.js'
import TaskController from '../app/Http/Controllers/TaskController.js'

// Rate limit stores (shared for consistent limiting)
const rateLimitStore = new MemoryRateLimitStore()

// Rate limiters with different configurations
const strictRateLimit = createRateLimitMiddleware({
  limit: 5,
  windowMs: 15 * 60 * 1000, // 15 minutes
  store: rateLimitStore,
  keyPrefix: 'rl:auth:',
})

const userRateLimit = createRateLimitMiddleware({
  limit: 1000,
  windowMs: 60 * 60 * 1000, // 1 hour
  store: rateLimitStore,
  keyPrefix: 'rl:user:',
  keyGenerator: async (ctx) => {
    const tokenInfo = ctx.get('guren:api-token') as { userId: string | number } | undefined
    return tokenInfo?.userId?.toString() ?? ctx.req.header('x-forwarded-for') ?? 'unknown'
  },
})

// Bearer token auth middleware
const requireAuth = createBearerTokenMiddleware({
  store: tokenStore,
})

// Public auth routes (with strict rate limiting)
Route.post('/api/auth/register', [AuthController, 'register'], strictRateLimit).name('auth.register')
Route.post('/api/auth/login', [AuthController, 'login'], strictRateLimit).name('auth.login')

// Authenticated auth routes
Route.group('/api/auth', () => {
  Route.get('/user', [AuthController, 'user'], requireAuth, userRateLimit).name('auth.user')
  Route.get('/tokens', [AuthController, 'listTokens'], requireAuth, userRateLimit).name('auth.tokens.index')
  Route.post('/tokens', [AuthController, 'createToken'], requireAuth, userRateLimit).name('auth.tokens.store')
  Route.delete('/tokens/:id', [AuthController, 'revokeToken'], requireAuth, userRateLimit).name('auth.tokens.destroy')
})

// Task routes (all authenticated with user-based rate limiting)
Route.group('/api/tasks', () => {
  Route.get('/', [TaskController, 'index'], requireAuth, userRateLimit).name('tasks.index')
  Route.post('/', [TaskController, 'store'], requireAuth, userRateLimit).name('tasks.store')
  Route.get('/:id', [TaskController, 'show'], requireAuth, userRateLimit).name('tasks.show')
  Route.put('/:id', [TaskController, 'update'], requireAuth, userRateLimit).name('tasks.update')
  Route.delete('/:id', [TaskController, 'destroy'], requireAuth, userRateLimit).name('tasks.destroy')
})
