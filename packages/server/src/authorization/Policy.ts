import type { AuthUser, Policy as PolicyInterface, AuthorizationResponse } from './types'
import { Response } from './Gate'

/**
 * Base policy class for model authorization.
 *
 * @example
 * ```typescript
 * class PostPolicy extends Policy {
 *   // Runs before all checks - return true/false to short-circuit
 *   before(user: AuthUser | null, ability: string) {
 *     if (user?.role === 'admin') {
 *       return true // Admins can do anything
 *     }
 *     return undefined // Continue to specific check
 *   }
 *
 *   viewAny(user: AuthUser | null) {
 *     return true // Anyone can view posts list
 *   }
 *
 *   view(user: AuthUser | null, post: Post) {
 *     return post.published || user?.id === post.authorId
 *   }
 *
 *   create(user: AuthUser | null) {
 *     return user !== null
 *   }
 *
 *   update(user: AuthUser | null, post: Post) {
 *     return user?.id === post.authorId
 *   }
 *
 *   delete(user: AuthUser | null, post: Post) {
 *     return user?.id === post.authorId
 *   }
 * }
 * ```
 */
export abstract class Policy implements PolicyInterface {
  /**
   * Perform pre-authorization checks.
   * Return true to allow, false to deny, undefined to continue to specific check.
   */
  before?(user: AuthUser | null, ability: string): boolean | undefined | Promise<boolean | undefined>

  /**
   * Allow the action.
   */
  protected allow(message?: string): AuthorizationResponse {
    return Response.allow(message)
  }

  /**
   * Deny the action.
   */
  protected deny(message?: string, code?: string): AuthorizationResponse {
    return Response.deny(message, code)
  }

  /**
   * Deny with a specific HTTP status.
   */
  protected denyWithStatus(status: number, message?: string): AuthorizationResponse & { status: number } {
    return Response.denyWithStatus(status, message)
  }

  /**
   * Deny as not found (404).
   */
  protected denyAsNotFound(message?: string): AuthorizationResponse & { status: 404 } {
    return Response.denyAsNotFound(message)
  }
}

/**
 * Create a simple policy from an object.
 */
export function definePolicy<T>(
  definition: {
    before?: (user: AuthUser | null, ability: string) => boolean | undefined | Promise<boolean | undefined>
    viewAny?: (user: AuthUser | null) => boolean | Promise<boolean>
    view?: (user: AuthUser | null, model: T) => boolean | Promise<boolean>
    create?: (user: AuthUser | null) => boolean | Promise<boolean>
    update?: (user: AuthUser | null, model: T) => boolean | Promise<boolean>
    delete?: (user: AuthUser | null, model: T) => boolean | Promise<boolean>
    restore?: (user: AuthUser | null, model: T) => boolean | Promise<boolean>
    forceDelete?: (user: AuthUser | null, model: T) => boolean | Promise<boolean>
  } & Record<
    string,
    ((user: AuthUser | null, ...args: any[]) => boolean | undefined | Promise<boolean | undefined>) | undefined
  >
): new () => Policy {
  return class extends Policy {
    before = definition.before

    viewAny(user: AuthUser | null): boolean | Promise<boolean> {
      return definition.viewAny?.(user) ?? false
    }

    view(user: AuthUser | null, model: T): boolean | Promise<boolean> {
      return definition.view?.(user, model) ?? false
    }

    create(user: AuthUser | null): boolean | Promise<boolean> {
      return definition.create?.(user) ?? false
    }

    update(user: AuthUser | null, model: T): boolean | Promise<boolean> {
      return definition.update?.(user, model) ?? false
    }

    delete(user: AuthUser | null, model: T): boolean | Promise<boolean> {
      return definition.delete?.(user, model) ?? false
    }

    restore(user: AuthUser | null, model: T): boolean | Promise<boolean> {
      return definition.restore?.(user, model) ?? false
    }

    forceDelete(user: AuthUser | null, model: T): boolean | Promise<boolean> {
      return definition.forceDelete?.(user, model) ?? false
    }
  } as unknown as new () => Policy
}
