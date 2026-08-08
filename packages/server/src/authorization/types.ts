import type { Context } from '../http/Application'

/**
 * User type for authorization.
 */
export interface AuthUser {
  id: string | number
}

/**
 * Gate callback function.
 */
export type GateCallback<Args extends unknown[] = unknown[]> = {
  bivarianceHack(
    user: AuthUser | null,
    ...args: Args
  ): boolean | Promise<boolean>
}['bivarianceHack']

/**
 * Gate before callbacks can short-circuit authorization.
 * Return true to allow, false to deny, or undefined to continue.
 */
export type GateBeforeCallback<Args extends unknown[] = unknown[]> = {
  bivarianceHack(
    user: AuthUser | null,
    ability: string,
    ...args: Args
  ): boolean | undefined | Promise<boolean | undefined>
}['bivarianceHack']

/**
 * Gate definition with optional callback.
 */
export interface GateDefinition {
  callback: GateCallback
}

/**
 * What a policy ability or gate callback may answer.
 *
 * `Response.deny()` and friends return an object, so it must be part of the
 * type — a signature of just `boolean` is what let a denial object be read
 * as an approval.
 */
export type PolicyResult = boolean | AuthorizationResponse

/**
 * Policy method type.
 */
export type PolicyMethod<T = unknown> = (
  user: AuthUser | null,
  model?: T,
  ...args: unknown[]
) => PolicyResult | Promise<PolicyResult>

/**
 * Policy class interface.
 */
export interface Policy {
  /**
   * Run before all other authorization checks.
   * Return true to allow, false to deny, undefined to continue to specific check.
   */
  before?(user: AuthUser | null, ability: string): boolean | undefined | Promise<boolean | undefined>
}

/**
 * Policy class constructor.
 */
export interface PolicyClass {
  new (): Policy
}

/**
 * Authorization response.
 */
export interface AuthorizationResponse {
  allowed: boolean
  message?: string
  code?: string
}

/**
 * Gate options.
 */
export interface GateOptions {
  /**
   * Default user resolver from context.
   */
  userResolver?: (ctx: Context) => AuthUser | null | Promise<AuthUser | null>
}

/**
 * Authorization check options.
 */
export interface AuthorizeOptions {
  /**
   * Custom message for denial.
   */
  message?: string

  /**
   * HTTP status code for denial.
   */
  status?: number
}

/**
 * Policy registration.
 */
export interface PolicyRegistration {
  modelClass: unknown
  policyClass: PolicyClass
}

/**
 * Resource actions for policies.
 */
export type ResourceAction =
  | 'viewAny'
  | 'view'
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'forceDelete'

/**
 * Response builder for authorization.
 */
export interface ResponseBuilder {
  allow(message?: string): AuthorizationResponse
  deny(message?: string, code?: string): AuthorizationResponse
  denyWithStatus(status: number, message?: string): AuthorizationResponse & { status: number }
  denyAsNotFound(message?: string): AuthorizationResponse & { status: 404 }
}
