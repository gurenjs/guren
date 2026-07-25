import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Context } from '../http/Application'
import type { Middleware } from '../http/middleware'
import type {
  ExceptionHandlerOptions,
  ExceptionReporter,
  ExceptionRenderer,
  ExceptionClass,
  RendererRegistration,
  ErrorResponse,
} from './types'
import { HttpException } from './HttpException'
import { renderErrorPage } from './error-page'

/**
 * Exception handler for centralized error handling.
 *
 * @example
 * ```typescript
 * const handler = new ExceptionHandler({ debug: false })
 *
 * // Report exceptions (e.g., to Sentry)
 * handler.report(async (error) => {
 *   await sentry.captureException(error)
 * })
 *
 * // Custom renderer for validation errors
 * handler.render(ValidationException, (error, ctx) => {
 *   return ctx.json({ errors: error.errors }, 422)
 * })
 *
 * // Don't report 404 errors
 * handler.dontReport(NotFoundHttpException)
 *
 * // Use as middleware
 * app.use('*', handler.middleware())
 * ```
 */
export class ExceptionHandler {
  /**
   * Exception reporters.
   */
  protected reporters: ExceptionReporter[] = []

  /**
   * Exception renderers.
   */
  protected renderers: RendererRegistration[] = []

  /**
   * Exception classes to not report.
   */
  protected dontReportClasses: ExceptionClass[] = []

  /**
   * Handler options.
   */
  protected options: ExceptionHandlerOptions

  constructor(options: ExceptionHandlerOptions = {}) {
    this.options = options
  }

  /**
   * Register an exception reporter.
   * Reporters are called for every exception (unless in dontReport list).
   */
  report(callback: ExceptionReporter): this {
    this.reporters.push(callback)
    return this
  }

  /**
   * Register a custom renderer for an exception type.
   */
  render<T extends Error>(
    errorClass: ExceptionClass<T>,
    renderer: ExceptionRenderer<T>
  ): this {
    this.renderers.push({
      errorClass,
      renderer: renderer as ExceptionRenderer,
    })
    return this
  }

  /**
   * Add an exception class to the don't report list.
   */
  dontReport(errorClass: ExceptionClass): this {
    this.dontReportClasses.push(errorClass)
    return this
  }

  /**
   * Check if debug mode is enabled.
   */
  shouldShowDetails(): boolean {
    if (this.options.isDebug) {
      return this.options.isDebug()
    }
    if (this.options.debug !== undefined) {
      return this.options.debug
    }
    return process.env.NODE_ENV !== 'production'
  }

  /**
   * Handle an exception.
   */
  async handle(error: Error, ctx: Context): Promise<Response> {
    // Report the exception
    await this.reportException(error)

    // Render the exception
    return this.renderException(error, ctx)
  }

  /**
   * Report an exception to all reporters.
   */
  protected async reportException(error: Error): Promise<void> {
    // Check if we should report
    if (this.shouldNotReport(error)) {
      return
    }

    // An app with no reporter configured would otherwise turn a 500 into a
    // rendered page and nothing else — on a hosted runtime, where stdout is
    // the only channel back to the operator, that leaves the failure
    // undiagnosable. Anything registering a reporter owns the reporting.
    if (this.reporters.length === 0) {
      console.error('Unhandled exception:', error)
    }

    // Call all reporters
    for (const reporter of this.reporters) {
      try {
        await reporter(error)
      } catch (reporterError) {
        // Don't let reporter errors crash the app
        console.error('Exception reporter failed:', reporterError)
      }
    }
  }

  /**
   * Check if an exception should not be reported.
   */
  protected shouldNotReport(error: Error): boolean {
    return this.dontReportClasses.some(
      (errorClass) => this.matchesErrorClass(error, errorClass)
    )
  }

  protected matchesErrorClass(error: Error, errorClass: ExceptionClass): boolean {
    const errorClassName = (errorClass as { name?: string }).name
    const errorName = error.name
    const constructorName = (error.constructor as { name?: string } | undefined)?.name

    return error instanceof errorClass
      || errorName === errorClassName
      || constructorName === errorClassName
  }

  /**
   * Render an exception to a response.
   */
  protected async renderException(error: Error, ctx: Context): Promise<Response> {
    // Check for custom renderer
    for (const { errorClass, renderer } of this.renderers) {
      if (this.matchesErrorClass(error, errorClass)) {
        return renderer(error, ctx)
      }
    }

    // Default rendering
    return this.renderDefaultException(error, ctx)
  }

  /**
   * Default exception rendering.
   */
  protected renderDefaultException(error: Error, ctx: Context): Response {
    const debug = this.shouldShowDetails()

    if (HttpException.isHttpException(error)) {
      const { status, body } = error.toResponse(debug)

      if (this.wantsHtmlResponse(ctx) && !debug) {
        return ctx.html(renderErrorPage(status, body.message), status as ContentfulStatusCode)
      }

      return ctx.json(body, status as ContentfulStatusCode)
    }

    // Use duck-typed statusCode if present (e.g. ModelNotFoundException → 404)
    const statusCode =
      'statusCode' in error && typeof (error as Record<string, unknown>).statusCode === 'number'
        ? (error as Record<string, unknown>).statusCode as number
        : 500

    const body: ErrorResponse = {
      message: statusCode < 500 || debug ? error.message : 'Internal Server Error',
    }

    if (debug) {
      body.exception = error.name
      body.stack = error.stack
    }

    if (this.wantsHtmlResponse(ctx) && !debug) {
      return ctx.html(renderErrorPage(statusCode, body.message), statusCode as ContentfulStatusCode)
    }

    return ctx.json(body, statusCode as ContentfulStatusCode)
  }

  /**
   * Determine whether the request expects an HTML response.
   * Returns false for Inertia, XHR, and JSON API requests so they
   * continue to receive JSON error payloads.
   */
  protected wantsHtmlResponse(ctx: Context): boolean {
    if (!ctx?.req?.header) return false
    const accept = ctx.req.header('accept') ?? ''
    const isJsonRequest =
      accept.includes('application/json') ||
      ctx.req.header('x-requested-with') === 'XMLHttpRequest' ||
      ctx.req.header('x-inertia') === 'true'

    return !isJsonRequest && accept.includes('text/html')
  }

  /**
   * Create middleware for exception handling.
   */
  middleware(): Middleware {
    return async (ctx, next) => {
      try {
        return await next()
      } catch (error) {
        const response = error instanceof Error
          ? await this.handle(error, ctx)
          : await this.handle(new Error(String(error)), ctx)

        ctx.res = response

        return response
      }
    }
  }
}

/**
 * Create an exception handler.
 */
export function createExceptionHandler(
  options?: ExceptionHandlerOptions
): ExceptionHandler {
  return new ExceptionHandler(options)
}

// Global exception handler
let globalExceptionHandler: ExceptionHandler | null = null

/**
 * Set the global exception handler.
 */
export function setExceptionHandler(handler: ExceptionHandler): void {
  globalExceptionHandler = handler
}

/**
 * Get the global exception handler.
 */
export function getExceptionHandler(): ExceptionHandler {
  if (!globalExceptionHandler) {
    throw new Error(
      'ExceptionHandler not initialized. Call setExceptionHandler() first.'
    )
  }
  return globalExceptionHandler
}

/**
 * Abort the request with an HTTP exception.
 */
export function abort(
  statusCode: number,
  message?: string,
  errors?: Record<string, string[]>
): never {
  throw new HttpException(statusCode, message ?? 'Error', errors)
}

/**
 * Abort if condition is true.
 */
export function abortIf(
  condition: boolean,
  statusCode: number,
  message?: string
): void {
  if (condition) {
    abort(statusCode, message)
  }
}

/**
 * Abort unless condition is true.
 */
export function abortUnless(
  condition: boolean,
  statusCode: number,
  message?: string
): void {
  if (!condition) {
    abort(statusCode, message)
  }
}
