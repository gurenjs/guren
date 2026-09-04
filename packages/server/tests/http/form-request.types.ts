import { FormRequest } from '../../src/http/FormRequest'
import { required, string } from '../../src/http/validation/rules'

/**
 * A type-only fixture: `bun run typecheck` is the assertion. No runtime test can
 * hold this line, since every caller that awaits behaves the same either way —
 * the assignment below fails to compile if `user()` returns a non-promise.
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
