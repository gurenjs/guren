import type { Context } from '../http/Application'

export interface AuthUser {
  id: string | number
}

export type GateCallback<Args extends unknown[] = unknown[]> = {
  bivarianceHack(
    user: AuthUser | null,
    ...args: Args
  ): PolicyResult | Promise<PolicyResult>
}['bivarianceHack']

/** Return true to allow, false to deny, or undefined to continue. */
export type GateBeforeCallback<Args extends unknown[] = unknown[]> = {
  bivarianceHack(
    user: AuthUser | null,
    ability: string,
    ...args: Args
  ): PolicyResult | undefined | Promise<PolicyResult | undefined>
}['bivarianceHack']

export interface GateDefinition {
  callback: GateCallback
}

/**
 * `Response.deny()` and friends return an object, so it must be part of the
 * type — a `boolean`-only signature let a denial be read as an approval.
 */
export type PolicyResult = boolean | AuthorizationResponse

export type PolicyMethod<T = unknown> = (
  user: AuthUser | null,
  model?: T,
  ...args: unknown[]
) => PolicyResult | Promise<PolicyResult>

export interface Policy {
  /** Return true to allow, false to deny, undefined to continue to the ability method. */
  before?(user: AuthUser | null, ability: string): PolicyResult | undefined | Promise<PolicyResult | undefined>
}

export interface PolicyClass {
  new (): Policy
}

export interface AuthorizationResponse {
  allowed: boolean
  message?: string
  code?: string
}

export interface GateOptions {
  userResolver?: (ctx: Context) => AuthUser | null | Promise<AuthUser | null>
}

export interface AuthorizeOptions {
  /** Custom message for denial. */
  message?: string

  /** HTTP status code for denial. */
  status?: number
}

export interface AuthorizeResourceOptions extends AuthorizeOptions {
  /**
   * Map an HTTP method (always uppercased) to a policy ability. Return
   * `undefined` to fall back to the built-in mapping; a method with no ability
   * from either source is denied with a 403.
   */
  abilityFor?: (method: string) => string | undefined
}

export interface PolicyRegistration {
  modelClass: unknown
  policyClass: PolicyClass
}

export type ResourceAction =
  | 'viewAny'
  | 'view'
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'forceDelete'

export interface ResponseBuilder {
  allow(message?: string): AuthorizationResponse
  deny(message?: string, code?: string): AuthorizationResponse
  denyWithStatus(status: number, message?: string): AuthorizationResponse & { status: number }
  denyAsNotFound(message?: string): AuthorizationResponse & { status: 404 }
}
