import type { Context } from '../http/Application'
import type { HttpException } from './HttpException'

export interface ErrorResponse {
  message: string
  errors?: Record<string, string[]>
  stack?: string
  exception?: string
}

export interface ExceptionHandlerOptions {
  /** @default true in development, false in production */
  debug?: boolean

  isDebug?: () => boolean
}

export type ExceptionReporter = (error: Error) => void | Promise<void>

export type ExceptionRenderer<T extends Error = Error> = (
  error: T,
  ctx: Context
) => Response | Promise<Response>

export type ExceptionClass<T extends Error = Error> = new (...args: any[]) => T

export interface RendererRegistration {
  errorClass: ExceptionClass
  renderer: ExceptionRenderer
}
