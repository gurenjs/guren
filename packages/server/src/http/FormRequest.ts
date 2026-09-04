import type { Context } from 'hono'
import type { ValidationRule } from './validation/types'
import { Validator } from './validation/Validator'
import { AuthorizationException } from '../errors/exceptions/AuthorizationException'
import { getAuthContext } from '../auth/context'
import { parseRequestPayload } from './request'

/**
 * Validation rules and authorization for one request type, in one class.
 *
 * @deprecated Legacy compatibility layer — prefer schema-first validation
 * via `this.validateBody()` / `validateQuery()` / `validateParams()`.
 */
export abstract class FormRequest<T = Record<string, unknown>> {
  protected ctx!: Context

  abstract rules(): Record<string, ValidationRule[]>

  authorize(): boolean | Promise<boolean> {
    return true
  }

  /** Override to customize validation messages. */
  messages(): Record<string, string> {
    return {}
  }

  /** Override to give fields human-readable names in errors. */
  attributes(): Record<string, string> {
    return {}
  }

  /**
   * Awaiting is load-bearing: `this.user() !== null` compiles and is always
   * true, because an unawaited call is a pending promise.
   */
  protected async user<TUser = unknown>(): Promise<TUser | null> {
    const auth = getAuthContext(this.ctx)
    return (await auth?.user<TUser>()) ?? null
  }

  /** Authorize, parse the body, validate, return typed data. */
  async handle(ctx: Context): Promise<T> {
    this.ctx = ctx

    const authorized = await this.authorize()
    if (!authorized) {
      throw new AuthorizationException('This action is unauthorized.')
    }

    const data = await this.parseBody()

    const rules = this.rules()
    const validator = Validator.make(rules, {
      messages: this.messages(),
      attributes: this.attributes(),
    })

    const validated = await validator.validateOrThrow(data)
    return validated as T
  }

  private async parseBody(): Promise<Record<string, unknown>> {
    return parseRequestPayload(this.ctx)
  }
}
