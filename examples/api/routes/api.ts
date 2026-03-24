import {
  Router,
  createRateLimitMiddleware,
  createBearerTokenMiddleware,
  MemoryRateLimitStore,
} from '@guren/core'
import AuthController from '../app/Http/Controllers/AuthController.js'
import TokenController from '../app/Http/Controllers/TokenController.js'
import TaskController from '../app/Http/Controllers/TaskController.js'
import { getTokenStore } from '../app/Providers/ApiTokenProvider.js'
import { RegisterSchema, LoginSchema, CreateTokenSchema } from '../app/Http/Validators/AuthValidator.js'
import { CreateTaskSchema, UpdateTaskSchema } from '../app/Http/Validators/TaskValidator.js'

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
  store: getTokenStore(),
})

export function registerApiRoutes(router: Router): void {
  router.post('/api/auth/register', { name: 'auth.register', body: RegisterSchema, middlewares: [strictRateLimit] }, [AuthController, 'register'])
  router.post('/api/auth/login', { name: 'auth.login', body: LoginSchema, middlewares: [strictRateLimit] }, [AuthController, 'login'])

  router.group('/api/auth', (auth) => {
    auth.get('/user', [AuthController, 'user'], requireAuth, userRateLimit).name('auth.user')
    auth.get('/tokens', [TokenController, 'index'], requireAuth, userRateLimit).name('auth.tokens.index')
    auth.post('/tokens', { name: 'auth.tokens.store', body: CreateTokenSchema, middlewares: [requireAuth, userRateLimit] }, [TokenController, 'store'])
    auth.delete('/tokens/:id', [TokenController, 'destroy'], requireAuth, userRateLimit).name('auth.tokens.destroy')
  })

  router.group('/api/tasks', (tasks) => {
    tasks.get('/', [TaskController, 'index'], requireAuth, userRateLimit).name('tasks.index')
    tasks.post('/', { name: 'tasks.store', body: CreateTaskSchema, middlewares: [requireAuth, userRateLimit] }, [TaskController, 'store'])
    tasks.get('/:id', [TaskController, 'show'], requireAuth, userRateLimit).name('tasks.show')
    tasks.put('/:id', { name: 'tasks.update', body: UpdateTaskSchema, middlewares: [requireAuth, userRateLimit] }, [TaskController, 'update'])
    tasks.delete('/:id', [TaskController, 'destroy'], requireAuth, userRateLimit).name('tasks.destroy')
  })
}

export default registerApiRoutes
