import type { Context } from 'hono'
import type { ValidationRule } from './validation/types'
import { Validator } from './validation/Validator'
import { AuthorizationException } from '../errors/exceptions/AuthorizationException'
import { getAuthContext } from '../auth/context'
import { parseRequestPayload } from './request'

/**
 * Base class for form request validation.
 *
 * FormRequest encapsulates both validation rules and authorization logic
 * for a single request type. Extend this class and define `rules()` and
 * optionally `authorize()` to create type-safe request validation.
 *
 * @example
 * ```typescript
 * interface StorePostData {
 *   title: string
 *   content: string
 *   status: 'draft' | 'published'
 * }
 *
 * class StorePostRequest extends FormRequest<StorePostData> {
 *   rules() {
 *     return {
 *       title: [required(), stringRule(), min(3), max(255)],
 *       content: [required(), stringRule()],
 *       status: [required(), inValues(['draft', 'published'])],
 *     }
 *   }
 *
 *   async authorize() {
 *     return (await this.user()) !== null
 *   }
 * }
 *
 * // In controller:
 * const data = await new StorePostRequest().handle(this.ctx)
 * // data is typed as StorePostData
 * ```
 *
 * @deprecated Legacy compatibility layer — prefer schema-first validation
 * via `this.validateBody()` / `validateQuery()` / `validateParams()`.
 */
export abstract class FormRequest<T = Record<string, unknown>> {
  protected ctx!: Context

  /**
   * Define validation rules for this request.
   * Return an object mapping field names to arrays of validation rules.
   */
  abstract rules(): Record<string, ValidationRule[]>

  /**
   * Determine if the user is authorized to make this request.
   * Override to implement authorization logic. Defaults to true.
   */
  authorize(): boolean | Promise<boolean> {
    return true
  }

  /**
   * Custom error messages for validation rules.
   * Override to provide custom messages.
   */
  messages(): Record<string, string> {
    return {}
  }

  /**
   * Custom attribute names for validation errors.
   * Override to provide human-readable field names.
   */
  attributes(): Record<string, string> {
    return {}
  }

  /**
   * Get the authenticated user from the request context.
   *
   * Awaiting is load-bearing: `this.user() !== null` compiles and is always
   * true, because an unawaited call is a pending promise.
   */
  protected async user<TUser = unknown>(): Promise<TUser | null> {
    const auth = getAuthContext(this.ctx)
    return (await auth?.user<TUser>()) ?? null
  }

  /**
   * Handle the form request: authorize, parse body, validate, return typed data.
   * Call it from a controller with the request context:
   * `const data = await new StorePostRequest().handle(this.ctx)`.
   */
  async handle(ctx: Context): Promise<T> {
    this.ctx = ctx

    // Authorization check
    const authorized = await this.authorize()
    if (!authorized) {
      throw new AuthorizationException('This action is unauthorized.')
    }

    // Parse request body
    const data = await this.parseBody()

    // Build validator from rules
    const rules = this.rules()
    const validator = Validator.make(rules, {
      messages: this.messages(),
      attributes: this.attributes(),
    })

    // Validate and throw on failure
    const validated = await validator.validateOrThrow(data)
    return validated as T
  }

  private async parseBody(): Promise<Record<string, unknown>> {
    return parseRequestPayload(this.ctx)
  }
}
