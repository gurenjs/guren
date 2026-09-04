import type { AuthUser, Policy as PolicyInterface, AuthorizationResponse, PolicyResult } from './types'
import { Response } from './Gate'

/**
 * Base policy class for model authorization. Ability methods are looked up on
 * the subclass by name (`viewAny`, `view`, `create`, `update`, `delete`,
 * `restore`, `forceDelete`, or any custom ability), each taking
 * `(user, model?, ...args)`.
 */
export abstract class Policy implements PolicyInterface {
  /** Return true to allow, false to deny, undefined to continue to the ability method. */
  before?(user: AuthUser | null, ability: string): PolicyResult | undefined | Promise<PolicyResult | undefined>

  protected allow(message?: string): AuthorizationResponse {
    return Response.allow(message)
  }

  protected deny(message?: string, code?: string): AuthorizationResponse {
    return Response.deny(message, code)
  }

  protected denyWithStatus(status: number, message?: string): AuthorizationResponse & { status: number } {
    return Response.denyWithStatus(status, message)
  }

  protected denyAsNotFound(message?: string): AuthorizationResponse & { status: 404 } {
    return Response.denyAsNotFound(message)
  }
}

/** Create a policy class from an object of ability functions. */
export function definePolicy<T>(
  definition: {
    before?: (user: AuthUser | null, ability: string) => PolicyResult | undefined | Promise<PolicyResult | undefined>
    viewAny?: (user: AuthUser | null) => PolicyResult | Promise<PolicyResult>
    view?: (user: AuthUser | null, model: T) => PolicyResult | Promise<PolicyResult>
    create?: (user: AuthUser | null) => PolicyResult | Promise<PolicyResult>
    update?: (user: AuthUser | null, model: T) => PolicyResult | Promise<PolicyResult>
    delete?: (user: AuthUser | null, model: T) => PolicyResult | Promise<PolicyResult>
    restore?: (user: AuthUser | null, model: T) => PolicyResult | Promise<PolicyResult>
    forceDelete?: (user: AuthUser | null, model: T) => PolicyResult | Promise<PolicyResult>
  } & Record<
    string,
    ((user: AuthUser | null, ...args: any[]) => PolicyResult | undefined | Promise<PolicyResult | undefined>) | undefined
  >
): new () => Policy {
  return class extends Policy {
    before = definition.before

    viewAny(user: AuthUser | null): PolicyResult | Promise<PolicyResult> {
      return definition.viewAny?.(user) ?? false
    }

    view(user: AuthUser | null, model: T): PolicyResult | Promise<PolicyResult> {
      return definition.view?.(user, model) ?? false
    }

    create(user: AuthUser | null): PolicyResult | Promise<PolicyResult> {
      return definition.create?.(user) ?? false
    }

    update(user: AuthUser | null, model: T): PolicyResult | Promise<PolicyResult> {
      return definition.update?.(user, model) ?? false
    }

    delete(user: AuthUser | null, model: T): PolicyResult | Promise<PolicyResult> {
      return definition.delete?.(user, model) ?? false
    }

    restore(user: AuthUser | null, model: T): PolicyResult | Promise<PolicyResult> {
      return definition.restore?.(user, model) ?? false
    }

    forceDelete(user: AuthUser | null, model: T): PolicyResult | Promise<PolicyResult> {
      return definition.forceDelete?.(user, model) ?? false
    }
  } as unknown as new () => Policy
}
