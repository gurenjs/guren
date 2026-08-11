import { FormRequest } from '../../src/http/FormRequest'
import { required, string } from '../../src/http/validation/rules'

/**
 * A type-only fixture: nothing here is ever executed, and `bun run typecheck`
 * is the assertion.
 *
 * `FormRequest.user()` used to be declared `(): unknown` while the
 * `AuthContext.user()` it delegates to was already async, so it handed back a
 * pending promise that the return type hid. No runtime test can hold that
 * line — every caller that awaits behaves identically under both signatures —
 * so the assignment below is the guard: it fails to compile if `user()` ever
 * goes back to returning a non-promise.
 */
export class TypedUserRequest extends FormRequest<{ title: string }> {
  rules() {
    return {
      title: [required(), string()],
    }
  }

  async authorize(): Promise<boolean> {
    const pending: Promise<unknown> = this.user()
    return (await pending) !== null
  }
}

/** The generic flows through to the resolved value, not just to `unknown`. */
export class TypedUserRecordRequest extends FormRequest<{ title: string }> {
  rules() {
    return {
      title: [required(), string()],
    }
  }

  async authorize(): Promise<boolean> {
    const user = await this.user<{ id: number }>()
    return user !== null && user.id > 0
  }
}
