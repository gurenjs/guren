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
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  TaskIdParamSchema,
  ListTasksQuerySchema,
} from '../app/Http/Validators/TaskValidator.js'
import { TokenIdParamSchema } from '../app/Http/Validators/AuthValidator.js'
import {
  AuthenticatedUserResponseSchema,
  CreateTokenResponseSchema,
  LoginResponseSchema,
  MessageResponseSchema,
  RegisterResponseSchema,
  TaskDetailResponseSchema,
  TaskListResponseSchema,
  TokenListResponseSchema,
} from '../app/Http/Validators/OpenApiSchema.js'

const rateLimitStore = new MemoryRateLimitStore()

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

const requireAuth = createBearerTokenMiddleware({
  store: getTokenStore(),
})

export function registerApiRoutes(router: Router): void {
  router.post('/api/auth/register', {
    name: 'auth.register',
    body: RegisterSchema,
    output: RegisterResponseSchema,
    summary: 'Register a user',
    description: 'Creates a user account and returns an initial API token.',
    tags: ['Auth'],
    middlewares: [strictRateLimit],
  }, [AuthController, 'register'])
  router.post('/api/auth/login', {
    name: 'auth.login',
    body: LoginSchema,
    output: LoginResponseSchema,
    summary: 'Log in with email and password',
    description: 'Authenticates a user and returns a fresh API token.',
    tags: ['Auth'],
    middlewares: [strictRateLimit],
  }, [AuthController, 'login'])

  router.group('/api/auth', (auth) => {
    auth.get('/user', {
      name: 'auth.user',
      output: AuthenticatedUserResponseSchema,
      summary: 'Fetch the authenticated user',
      description: 'Returns the current token owner and granted token abilities.',
      tags: ['Auth'],
      middlewares: [requireAuth, userRateLimit],
    }, [AuthController, 'user'])
    auth.get('/tokens', {
      name: 'auth.tokens.index',
      output: TokenListResponseSchema,
      summary: 'List API tokens',
      description: 'Returns the active API tokens for the authenticated user.',
      tags: ['Tokens'],
      middlewares: [requireAuth, userRateLimit],
    }, [TokenController, 'index'])
    auth.post('/tokens', {
      name: 'auth.tokens.store',
      body: CreateTokenSchema,
      output: CreateTokenResponseSchema,
      summary: 'Create an API token',
      description: 'Creates a personal access token for the authenticated user.',
      tags: ['Tokens'],
      middlewares: [requireAuth, userRateLimit],
    }, [TokenController, 'store'])
    auth.delete('/tokens/:id', {
      name: 'auth.tokens.destroy',
      params: TokenIdParamSchema,
      output: MessageResponseSchema,
      summary: 'Revoke an API token',
      description: 'Revokes a token that belongs to the authenticated user.',
      tags: ['Tokens'],
      middlewares: [requireAuth, userRateLimit],
    }, [TokenController, 'destroy'])
  })

  router.group('/api/tasks', (tasks) => {
    tasks.get('/', {
      name: 'tasks.index',
      query: ListTasksQuerySchema,
      output: TaskListResponseSchema,
      summary: 'List tasks',
      description: 'Returns paginated tasks for the authenticated user.',
      tags: ['Tasks'],
      middlewares: [requireAuth, userRateLimit],
    }, [TaskController, 'index'])
    tasks.post('/', {
      name: 'tasks.store',
      body: CreateTaskSchema,
      output: TaskDetailResponseSchema,
      summary: 'Create a task',
      description: 'Creates a new task for the authenticated user.',
      tags: ['Tasks'],
      middlewares: [requireAuth, userRateLimit],
    }, [TaskController, 'store'])
    tasks.get('/:id', {
      name: 'tasks.show',
      params: TaskIdParamSchema,
      output: TaskDetailResponseSchema,
      summary: 'Fetch a task',
      description: 'Returns a single task owned by the authenticated user.',
      tags: ['Tasks'],
      middlewares: [requireAuth, userRateLimit],
    }, [TaskController, 'show'])
    tasks.put('/:id', {
      name: 'tasks.update',
      params: TaskIdParamSchema,
      body: UpdateTaskSchema,
      output: TaskDetailResponseSchema,
      summary: 'Update a task',
      description: 'Updates a task owned by the authenticated user.',
      tags: ['Tasks'],
      middlewares: [requireAuth, userRateLimit],
    }, [TaskController, 'update'])
    tasks.delete('/:id', {
      name: 'tasks.destroy',
      params: TaskIdParamSchema,
      output: MessageResponseSchema,
      summary: 'Delete a task',
      description: 'Deletes a task owned by the authenticated user.',
      tags: ['Tasks'],
      middlewares: [requireAuth, userRateLimit],
    }, [TaskController, 'destroy'])
  })
}

export default registerApiRoutes
