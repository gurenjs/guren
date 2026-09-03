import type { Context } from '../http/Application'

/**
 * Error response structure.
 */
export interface ErrorResponse {
  message: string
  errors?: Record<string, string[]>
  stack?: string
  exception?: string
}

/**
 * Exception handler options.
 */
export interface ExceptionHandlerOptions {
  /**
   * Whether to show detailed error information.
   * Default: true in development, false in production.
   */
  debug?: boolean

  /**
   * Custom debug detection function.
   */
  isDebug?: () => boolean
}

/**
 * Exception reporter callback.
 */
export type ExceptionReporter = (error: Error) => void | Promise<void>

/**
 * Exception renderer callback.
 */
export type ExceptionRenderer<T extends Error = Error> = (
  error: T,
  ctx: Context
) => Response | Promise<Response>

/**
 * Exception class type.
 */
export type ExceptionClass<T extends Error = Error> = new (...args: any[]) => T

/**
 * Renderer registration.
 */
export interface RendererRegistration {
  errorClass: ExceptionClass
  renderer: ExceptionRenderer
}
