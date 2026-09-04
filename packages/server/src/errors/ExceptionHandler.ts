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

/** Centralized error handling: reporting, per-class renderers, middleware. */
export class ExceptionHandler {
  protected reporters: ExceptionReporter[] = []

  protected renderers: RendererRegistration[] = []

  protected dontReportClasses: ExceptionClass[] = []

  protected options: ExceptionHandlerOptions

  constructor(options: ExceptionHandlerOptions = {}) {
    this.options = options
  }

  /** Reporters run for every exception outside the `dontReport` list. */
  report(callback: ExceptionReporter): this {
    this.reporters.push(callback)
    return this
  }

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

  dontReport(errorClass: ExceptionClass): this {
    this.dontReportClasses.push(errorClass)
    return this
  }

  shouldShowDetails(): boolean {
    if (this.options.isDebug) {
      return this.options.isDebug()
    }
    if (this.options.debug !== undefined) {
      return this.options.debug
    }
    return process.env.NODE_ENV !== 'production'
  }

  async handle(error: Error, ctx: Context): Promise<Response> {
    await this.reportException(error)

    return this.renderException(error, ctx)
  }

  protected async reportException(error: Error): Promise<void> {
    if (this.shouldNotReport(error)) {
      return
    }

    // Last-resort logging for an app with no reporter, where stdout is the
    // only channel back to the operator. 5xx only: a 4xx is already delivered
    // to the caller in full, and logging it would print a stack trace per
    // rejected request. Not `shouldNotReport()` — a *registered* reporter
    // still receives 4xx.
    if (this.reporters.length === 0 && resolveExceptionStatus(error) >= 500) {
      console.error('Unhandled exception:', error)
    }

    for (const reporter of this.reporters) {
      try {
        await reporter(error)
      } catch (reporterError) {
        console.error('Exception reporter failed:', reporterError)
      }
    }
  }

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

  protected async renderException(error: Error, ctx: Context): Promise<Response> {
    for (const { errorClass, renderer } of this.renderers) {
      if (this.matchesErrorClass(error, errorClass)) {
        return renderer(error, ctx)
      }
    }

    return this.renderDefaultException(error, ctx)
  }

  protected renderDefaultException(error: Error, ctx: Context): Response {
    const debug = this.shouldShowDetails()
    // Resolved before the branch so this renders with the same number
    // `reportException` judged it by; `toResponse()` supplies only the body.
    const statusCode = resolveExceptionStatus(error)

    if (HttpException.isHttpException(error)) {
      const { body } = error.toResponse(debug)

      if (this.wantsHtmlResponse(ctx) && !debug) {
        return ctx.html(renderErrorPage(statusCode, body.message), statusCode as ContentfulStatusCode)
      }

      return ctx.json(body, statusCode as ContentfulStatusCode)
    }

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

  /** False for Inertia, XHR and JSON callers, which need a JSON payload. */
  protected wantsHtmlResponse(ctx: Context): boolean {
    if (!ctx?.req?.header) return false
    const accept = ctx.req.header('accept') ?? ''
    const isJsonRequest =
      accept.includes('application/json') ||
      ctx.req.header('x-requested-with') === 'XMLHttpRequest' ||
      ctx.req.header('x-inertia') === 'true'

    return !isJsonRequest && accept.includes('text/html')
  }

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
 * The HTTP status an exception carries, or 500 when it names none. Duck-typed
 * on `statusCode` rather than `instanceof`, so a foreign exception crossing a
 * package boundary (`ModelNotFoundException` from `@guren/orm`) still renders
 * as its own 404. The one rule both halves of the handler read: rendering and
 * the fallback logger must judge an exception by the same number.
 */
function resolveExceptionStatus(error: unknown): number {
  const statusCode = (error as { statusCode?: unknown } | null | undefined)?.statusCode
  return typeof statusCode === 'number' ? statusCode : 500
}

export function createExceptionHandler(
  options?: ExceptionHandlerOptions
): ExceptionHandler {
  return new ExceptionHandler(options)
}

let globalExceptionHandler: ExceptionHandler | null = null

export function setExceptionHandler(handler: ExceptionHandler): void {
  globalExceptionHandler = handler
}

export function getExceptionHandler(): ExceptionHandler {
  if (!globalExceptionHandler) {
    throw new Error(
      'ExceptionHandler not initialized. Call setExceptionHandler() first.'
    )
  }
  return globalExceptionHandler
}

export function abort(
  statusCode: number,
  message?: string,
  errors?: Record<string, string[]>
): never {
  throw new HttpException(statusCode, message ?? 'Error', errors)
}

export function abortIf(
  condition: boolean,
  statusCode: number,
  message?: string
): void {
  if (condition) {
    abort(statusCode, message)
  }
}

export function abortUnless(
  condition: boolean,
  statusCode: number,
  message?: string
): void {
  if (!condition) {
    abort(statusCode, message)
  }
}
