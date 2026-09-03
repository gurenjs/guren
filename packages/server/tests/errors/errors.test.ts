import { describe, expect, it, beforeEach } from 'bun:test'
import {
  HttpException,
  ExceptionHandler,
  createExceptionHandler,
  ValidationException,
  AuthenticationException,
  AuthorizationException,
  NotFoundHttpException,
  MethodNotAllowedException,
  abort,
  abortIf,
  abortUnless,
} from '../../src/errors'

describe('HttpException', () => {
  describe('constructor', () => {
    it('should create exception with status code and message', () => {
      const error = new HttpException(404, 'Not Found')

      expect(error.statusCode).toBe(404)
      expect(error.message).toBe('Not Found')
      expect(error.name).toBe('HttpException')
    })

    it('should create exception with errors', () => {
      const errors = { email: ['Invalid email'] }
      const error = new HttpException(422, 'Validation failed', errors)

      expect(error.errors).toEqual(errors)
    })

    it('should create exception with data', () => {
      const data = { code: 'USER_NOT_FOUND' }
      const error = new HttpException(404, 'Not Found', undefined, data)

      expect(error.data).toEqual(data)
    })
  })

  describe('toResponse', () => {
    it('should return status and body', () => {
      const error = new HttpException(400, 'Bad Request')
      const { status, body } = error.toResponse()

      expect(status).toBe(400)
      expect(body.message).toBe('Bad Request')
    })

    it('should include errors in body', () => {
      const error = new HttpException(422, 'Validation failed', {
        email: ['Invalid'],
      })
      const { body } = error.toResponse()

      expect(body.errors).toEqual({ email: ['Invalid'] })
    })

    it('should include debug info when enabled', () => {
      const error = new HttpException(500, 'Error')
      const { body } = error.toResponse(true)

      expect(body.exception).toBe('HttpException')
      expect(body.stack).toBeDefined()
    })

    it('should not include debug info by default', () => {
      const error = new HttpException(500, 'Error')
      const { body } = error.toResponse()

      expect(body.exception).toBeUndefined()
      expect(body.stack).toBeUndefined()
    })
  })

  describe('toJSON', () => {
    it('should return JSON representation', () => {
      const error = new HttpException(404, 'Not Found', undefined, { code: 'NF' })
      const json = error.toJSON()

      expect(json.name).toBe('HttpException')
      expect(json.message).toBe('Not Found')
      expect(json.statusCode).toBe(404)
      expect(json.data).toEqual({ code: 'NF' })
    })
  })

  describe('factory methods', () => {
    it('should create badRequest (400)', () => {
      const error = HttpException.badRequest()
      expect(error.statusCode).toBe(400)
      expect(error.message).toBe('Bad Request')
    })

    it('should create unauthorized (401)', () => {
      const error = HttpException.unauthorized('Invalid token')
      expect(error.statusCode).toBe(401)
      expect(error.message).toBe('Invalid token')
    })

    it('should create forbidden (403)', () => {
      const error = HttpException.forbidden()
      expect(error.statusCode).toBe(403)
    })

    it('should create notFound (404)', () => {
      const error = HttpException.notFound('User not found')
      expect(error.statusCode).toBe(404)
      expect(error.message).toBe('User not found')
    })

    it('should create methodNotAllowed (405)', () => {
      const error = HttpException.methodNotAllowed()
      expect(error.statusCode).toBe(405)
    })

    it('should create conflict (409)', () => {
      const error = HttpException.conflict()
      expect(error.statusCode).toBe(409)
    })

    it('should create unprocessable (422)', () => {
      const errors = { email: ['Required'] }
      const error = HttpException.unprocessable('Validation failed', errors)
      expect(error.statusCode).toBe(422)
      expect(error.errors).toEqual(errors)
    })

    it('should create tooManyRequests (429)', () => {
      const error = HttpException.tooManyRequests()
      expect(error.statusCode).toBe(429)
    })

    it('should create internal (500)', () => {
      const error = HttpException.internal()
      expect(error.statusCode).toBe(500)
    })

    it('should create serviceUnavailable (503)', () => {
      const error = HttpException.serviceUnavailable()
      expect(error.statusCode).toBe(503)
    })
  })

  describe('isHttpException', () => {
    it('should return true for HttpException', () => {
      const error = new HttpException(400, 'Error')
      expect(HttpException.isHttpException(error)).toBe(true)
    })

    it('should return false for regular Error', () => {
      const error = new Error('Error')
      expect(HttpException.isHttpException(error)).toBe(false)
    })

    it('should return false for non-Error', () => {
      expect(HttpException.isHttpException('error')).toBe(false)
    })
  })
})

describe('ValidationException', () => {
  it('should create with errors', () => {
    const errors = {
      email: ['Required', 'Invalid format'],
      password: ['Too short'],
    }
    const error = new ValidationException(errors)

    expect(error.statusCode).toBe(422)
    expect(error.errors).toEqual(errors)
    expect(error.name).toBe('ValidationException')
  })

  it('should create with custom message', () => {
    const error = new ValidationException({}, 'Custom validation message')
    expect(error.message).toBe('Custom validation message')
  })

  describe('fromZodError', () => {
    it('should convert Zod-like error', () => {
      const zodError = {
        issues: [
          { path: ['email'], message: 'Required' },
          { path: ['email'], message: 'Invalid' },
          { path: ['password'], message: 'Too short' },
        ],
      }

      const error = ValidationException.fromZodError(zodError)

      expect(error.errors).toEqual({
        email: ['Required', 'Invalid'],
        password: ['Too short'],
      })
    })

    it('should handle nested paths', () => {
      const zodError = {
        issues: [{ path: ['address', 'city'], message: 'Required' }],
      }

      const error = ValidationException.fromZodError(zodError)
      expect(error.errors?.['address.city']).toEqual(['Required'])
    })
  })

  describe('helper methods', () => {
    const error = new ValidationException({
      email: ['Required', 'Invalid'],
      password: ['Too short'],
    })

    it('should get field errors', () => {
      expect(error.getFieldErrors('email')).toEqual(['Required', 'Invalid'])
      expect(error.getFieldErrors('unknown')).toEqual([])
    })

    it('should check if field has error', () => {
      expect(error.hasFieldError('email')).toBe(true)
      expect(error.hasFieldError('unknown')).toBe(false)
    })

    it('should get first error', () => {
      expect(error.getFirstError('email')).toBe('Required')
      expect(error.getFirstError('unknown')).toBeNull()
    })

    it('should get all messages', () => {
      const messages = error.getAllMessages()
      expect(messages).toContain('Required')
      expect(messages).toContain('Invalid')
      expect(messages).toContain('Too short')
    })
  })
})

describe('AuthenticationException', () => {
  it('should create with default message', () => {
    const error = new AuthenticationException()

    expect(error.statusCode).toBe(401)
    expect(error.message).toBe('Unauthenticated.')
    expect(error.name).toBe('AuthenticationException')
  })

  it('should create with custom message and guard', () => {
    const error = new AuthenticationException('Token expired', 'api')

    expect(error.message).toBe('Token expired')
    expect(error.guard).toBe('api')
  })

  it('should create with redirect', () => {
    const error = AuthenticationException.withRedirect('/login')
    expect(error.redirectTo).toBe('/login')
  })

  it('should create for guard', () => {
    const error = AuthenticationException.forGuard('admin', 'Admin access required')
    expect(error.guard).toBe('admin')
    expect(error.message).toBe('Admin access required')
  })
})

describe('AuthorizationException', () => {
  it('should create with default message', () => {
    const error = new AuthorizationException()

    expect(error.statusCode).toBe(403)
    expect(error.message).toBe('This action is unauthorized.')
    expect(error.name).toBe('AuthorizationException')
  })

  it('should create with action and resource', () => {
    const error = new AuthorizationException('Cannot edit', 'edit', 'Post')

    expect(error.action).toBe('edit')
    expect(error.resource).toBe('Post')
  })

  describe('forAction', () => {
    it('should create for action', () => {
      const error = AuthorizationException.forAction('delete')
      expect(error.message).toBe('You are not authorized to delete.')
    })

    it('should create for action and resource', () => {
      const error = AuthorizationException.forAction('edit', 'Post')
      expect(error.message).toBe('You are not authorized to edit this Post.')
    })
  })

  describe('deny', () => {
    it('should deny access', () => {
      const error = AuthorizationException.deny()
      expect(error.message).toBe('Access denied.')
    })

    it('should deny access to resource', () => {
      const error = AuthorizationException.deny('Admin Panel')
      expect(error.message).toBe('Access to Admin Panel denied.')
    })
  })
})

describe('NotFoundHttpException', () => {
  it('should create with default message', () => {
    const error = new NotFoundHttpException()

    expect(error.statusCode).toBe(404)
    expect(error.message).toBe('Not Found')
    expect(error.name).toBe('NotFoundHttpException')
  })

  it('should create with resource info', () => {
    const error = new NotFoundHttpException('User not found', 'User', 123)

    expect(error.resourceType).toBe('User')
    expect(error.resourceId).toBe(123)
  })

  describe('forModel', () => {
    it('should create for model', () => {
      const error = NotFoundHttpException.forModel('User', 42)

      expect(error.message).toBe('User with ID 42 not found.')
      expect(error.resourceType).toBe('User')
      expect(error.resourceId).toBe(42)
    })
  })

  describe('forRoute', () => {
    it('should create for route', () => {
      const error = NotFoundHttpException.forRoute('/api/users')
      expect(error.message).toBe('Route /api/users not found.')
    })
  })

  describe('forResource', () => {
    it('should create for resource', () => {
      const error = NotFoundHttpException.forResource('File')
      expect(error.message).toBe('File not found.')
    })
  })
})

describe('MethodNotAllowedException', () => {
  it('should create with default message', () => {
    const error = new MethodNotAllowedException()

    expect(error.statusCode).toBe(405)
    expect(error.name).toBe('MethodNotAllowedException')
  })

  it('should create with method info', () => {
    const error = new MethodNotAllowedException('POST', ['GET', 'HEAD'])

    expect(error.method).toBe('POST')
    expect(error.allowedMethods).toEqual(['GET', 'HEAD'])
    expect(error.message).toBe('Method POST is not allowed.')
  })

  describe('getAllowHeader', () => {
    it('should return Allow header value', () => {
      const error = new MethodNotAllowedException('POST', ['GET', 'HEAD'])
      expect(error.getAllowHeader()).toBe('GET, HEAD')
    })

    it('should return empty string if no methods', () => {
      const error = new MethodNotAllowedException()
      expect(error.getAllowHeader()).toBe('')
    })
  })

  describe('forMethod', () => {
    it('should create with detailed message', () => {
      const error = MethodNotAllowedException.forMethod('DELETE', ['GET', 'POST'])

      expect(error.message).toBe(
        'Method DELETE not allowed. Allowed methods: GET, POST'
      )
    })
  })
})

describe('ExceptionHandler', () => {
  let handler: ExceptionHandler

  // Mock context
  const createMockContext = () => ({
    json: (body: unknown, status?: number) => {
      return new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  })

  beforeEach(() => {
    handler = new ExceptionHandler({ debug: false })
  })

  describe('shouldShowDetails', () => {
    it('should respect debug option', () => {
      const debugHandler = new ExceptionHandler({ debug: true })
      const prodHandler = new ExceptionHandler({ debug: false })

      expect(debugHandler.shouldShowDetails()).toBe(true)
      expect(prodHandler.shouldShowDetails()).toBe(false)
    })

    it('should use custom isDebug function', () => {
      const customHandler = new ExceptionHandler({
        isDebug: () => true,
      })

      expect(customHandler.shouldShowDetails()).toBe(true)
    })
  })

  describe('report', () => {
    it('should register reporter', async () => {
      const reported: Error[] = []
      handler.report((error) => {
        reported.push(error)
      })

      const error = new Error('Test error')
      const ctx = createMockContext()

      await handler.handle(error, ctx as any)

      expect(reported).toHaveLength(1)
      expect(reported[0]).toBe(error)
    })

    it('should call multiple reporters', async () => {
      let count = 0
      handler.report(() => { count++ })
      handler.report(() => { count++ })

      await handler.handle(new Error('Test'), createMockContext() as any)

      expect(count).toBe(2)
    })
  })

  /**
   * The console fallback exists so an app with no reporter still surfaces a
   * *server* failure on stdout. A 4xx is not one: it is delivered to the
   * caller in full, so logging it turns a route rejecting invalid input as
   * designed into a stack trace per request — which is how a correct 422 came
   * to be printed as `Unhandled exception:`.
   */
  describe('fallback console reporting', () => {
    const captureConsoleError = () => {
      const calls: unknown[][] = []
      const original = console.error
      console.error = (...args: unknown[]) => {
        calls.push(args)
      }
      return {
        calls,
        restore: () => {
          console.error = original
        },
      }
    }

    it('should not log client errors when no reporter is registered', async () => {
      const captured = captureConsoleError()
      try {
        await handler.handle(
          new ValidationException({ title: ['Too short'] }),
          createMockContext() as any
        )
        await handler.handle(new AuthorizationException(), createMockContext() as any)
        await handler.handle(new NotFoundHttpException(), createMockContext() as any)
      } finally {
        captured.restore()
      }

      expect(captured.calls).toEqual([])
    })

    it('should log server errors when no reporter is registered', async () => {
      const captured = captureConsoleError()
      const httpFailure = new HttpException(500, 'Boom')
      const bare = new Error('Bare failure')
      try {
        await handler.handle(httpFailure, createMockContext() as any)
        await handler.handle(bare, createMockContext() as any)
      } finally {
        captured.restore()
      }

      expect(captured.calls).toHaveLength(2)
      expect(captured.calls[0]).toEqual(['Unhandled exception:', httpFailure])
      expect(captured.calls[1]).toEqual(['Unhandled exception:', bare])
    })

    it('should still hand client errors to a registered reporter', async () => {
      const reported: Error[] = []
      handler.report((error) => {
        reported.push(error)
      })

      const error = new ValidationException({ title: ['Too short'] })
      const captured = captureConsoleError()
      try {
        await handler.handle(error, createMockContext() as any)
      } finally {
        captured.restore()
      }

      expect(reported).toEqual([error])
      expect(captured.calls).toEqual([])
    })
  })

  describe('dontReport', () => {
    it('should not report excluded exceptions', async () => {
      const reported: Error[] = []
      handler.report((error) => {
        reported.push(error)
      })
      handler.dontReport(NotFoundHttpException)

      await handler.handle(
        new NotFoundHttpException(),
        createMockContext() as any
      )

      expect(reported).toHaveLength(0)
    })
  })

  describe('render', () => {
    it('should use custom renderer', async () => {
      handler.render(ValidationException, (error, ctx) => {
        return ctx.json({ custom: true, errors: error.errors }, 422)
      })

      const error = new ValidationException({ email: ['Invalid'] })
      const ctx = createMockContext()

      const response = await handler.handle(error, ctx as any)
      const body = await response.json()

      expect(body.custom).toBe(true)
      expect(body.errors).toEqual({ email: ['Invalid'] })
    })
  })

  describe('handle', () => {
    it('should handle HttpException', async () => {
      const error = HttpException.notFound('User not found')
      const ctx = createMockContext()

      const response = await handler.handle(error, ctx as any)

      expect(response.status).toBe(404)
      const body = await response.json()
      expect(body.message).toBe('User not found')
    })

    it('should handle generic Error', async () => {
      const error = new Error('Something went wrong')
      const ctx = createMockContext()

      const response = await handler.handle(error, ctx as any)

      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.message).toBe('Internal Server Error')
    })

    it('should show details in debug mode', async () => {
      const debugHandler = new ExceptionHandler({ debug: true })
      const error = new Error('Debug error')
      const ctx = createMockContext()

      const response = await debugHandler.handle(error, ctx as any)
      const body = await response.json()

      expect(body.message).toBe('Debug error')
      expect(body.exception).toBe('Error')
      expect(body.stack).toBeDefined()
    })
  })

  describe('middleware', () => {
    it('should catch and handle errors', async () => {
      const middleware = handler.middleware()
      const ctx = createMockContext()

      const response = await middleware(ctx as any, async () => {
        throw HttpException.badRequest('Invalid input')
      })

      expect(response?.status).toBe(400)
    })

    it('should pass through successful requests', async () => {
      const middleware = handler.middleware()
      const ctx = createMockContext()

      let called = false
      await middleware(ctx as any, async () => {
        called = true
      })

      expect(called).toBe(true)
    })

    it('should handle non-Error throws', async () => {
      const middleware = handler.middleware()
      const ctx = createMockContext()

      const response = await middleware(ctx as any, async () => {
        throw 'string error'
      })

      expect(response?.status).toBe(500)
    })
  })
})

describe('abort helpers', () => {
  describe('abort', () => {
    it('should throw HttpException', () => {
      expect(() => abort(400, 'Bad Request')).toThrow(HttpException)
    })

    it('should throw with correct status', () => {
      try {
        abort(404, 'Not Found')
      } catch (error) {
        expect((error as HttpException).statusCode).toBe(404)
      }
    })
  })

  describe('abortIf', () => {
    it('should abort if condition is true', () => {
      expect(() => abortIf(true, 400, 'Error')).toThrow(HttpException)
    })

    it('should not abort if condition is false', () => {
      expect(() => abortIf(false, 400, 'Error')).not.toThrow()
    })
  })

  describe('abortUnless', () => {
    it('should abort if condition is false', () => {
      expect(() => abortUnless(false, 400, 'Error')).toThrow(HttpException)
    })

    it('should not abort if condition is true', () => {
      expect(() => abortUnless(true, 400, 'Error')).not.toThrow()
    })
  })
})

describe('createExceptionHandler', () => {
  it('should create handler with options', () => {
    const handler = createExceptionHandler({ debug: true })
    expect(handler.shouldShowDetails()).toBe(true)
  })
})
