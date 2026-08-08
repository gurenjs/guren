import type { Context } from '../http/Application'
import type {
  AuthUser,
  GateCallback,
  GateBeforeCallback,
  GateDefinition,
  GateOptions,
  PolicyClass,
  Policy,
  AuthorizationResponse,
  ResponseBuilder,
} from './types'
import { AuthorizationException, HttpException } from '../errors'

/**
 * Response builder for authorization checks.
 */
export const Response: ResponseBuilder = {
  allow(message?: string): AuthorizationResponse {
    return { allowed: true, message }
  },

  deny(message?: string, code?: string): AuthorizationResponse {
    return { allowed: false, message: message ?? 'This action is unauthorized.', code }
  },

  denyWithStatus(status: number, message?: string): AuthorizationResponse & { status: number } {
    return { allowed: false, message: message ?? 'This action is unauthorized.', status }
  },

  denyAsNotFound(message?: string): AuthorizationResponse & { status: 404 } {
    return { allowed: false, message: message ?? 'Not found.', status: 404 }
  },
}

/**
 * Narrow a policy/gate return value to an `AuthorizationResponse`.
 *
 * Policies may return either a boolean or one of the `Response` objects
 * produced by `allow()`/`deny()`/`denyWithStatus()`/`denyAsNotFound()`.
 */
export function isAuthorizationResponse(value: unknown): value is AuthorizationResponse {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as AuthorizationResponse).allowed === 'boolean'
  )
}

/**
 * Normalize whatever a policy or gate callback returned into a response.
 *
 * A `{ allowed: false }` object is truthy, so anything that decides access
 * from the raw return value fails open. Every path in this class routes
 * through here, and unknown shapes deny.
 */
function toAuthorizationResponse(value: unknown): AuthorizationResponse {
  if (isAuthorizationResponse(value)) {
    return value
  }
  return value === true ? Response.allow() : Response.deny()
}

/**
 * Build the exception for a denial, honouring `denyWithStatus()` /
 * `denyAsNotFound()` so a policy can hide a record as a 404.
 */
function denialToException(response: AuthorizationResponse): Error {
  const message = response.message ?? 'This action is unauthorized.'
  const status = (response as AuthorizationResponse & { status?: number }).status

  if (typeof status === 'number' && status !== 403) {
    return new HttpException(status, message)
  }

  return new AuthorizationException(message)
}

/**
 * Authorization gate for defining and checking abilities.
 *
 * @example
 * ```typescript
 * const gate = new Gate()
 *
 * // Define abilities
 * gate.define('edit-post', (user, post) => user.id === post.authorId)
 * gate.define('admin', (user) => user.role === 'admin')
 *
 * // Check abilities
 * if (await gate.allows('edit-post', post)) {
 *   // User can edit
 * }
 *
 * // Or throw on denial
 * await gate.authorize('edit-post', post) // throws if not allowed
 * ```
 */
export class Gate {
  /**
   * Defined gates.
   */
  protected gates: Map<string, GateDefinition> = new Map()

  /**
   * Registered policies.
   */
  protected policies: Map<unknown, PolicyClass> = new Map()

  /**
   * Policy instances cache.
   */
  protected policyInstances: Map<PolicyClass, Policy> = new Map()

  /**
   * Before callbacks.
   */
  protected beforeCallbacks: GateBeforeCallback[] = []

  /**
   * After callbacks.
   */
  protected afterCallbacks: Array<
    (user: AuthUser | null, ability: string, result: boolean, args: unknown[]) => void | Promise<void>
  > = []

  /**
   * User resolver function.
   */
  protected userResolver?: (ctx: Context) => AuthUser | null | Promise<AuthUser | null>

  /**
   * Current user for checks.
   */
  protected currentUser: AuthUser | null = null

  constructor(options: GateOptions = {}) {
    this.userResolver = options.userResolver
  }

  /**
   * Define a new gate.
   */
  define<Args extends unknown[]>(ability: string, callback: GateCallback<Args>): this {
    this.gates.set(ability, { callback })
    return this
  }

  /**
   * Register a policy for a model class.
   */
  policy(modelClass: unknown, policyClass: PolicyClass): this {
    this.policies.set(modelClass, policyClass)
    return this
  }

  /**
   * Register a before callback.
   * Return true to allow, false to deny, undefined to continue.
   */
  before<Args extends unknown[]>(callback: GateBeforeCallback<Args>): this {
    this.beforeCallbacks.push(callback)
    return this
  }

  /**
   * Register an after callback.
   */
  after(
    callback: (user: AuthUser | null, ability: string, result: boolean, args: unknown[]) => void | Promise<void>
  ): this {
    this.afterCallbacks.push(callback)
    return this
  }

  /**
   * Set the current user for authorization checks.
   */
  forUser(user: AuthUser | null): this {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)),
      this
    ) as this
    clone.currentUser = user
    return clone
  }

  /**
   * Resolve the user from context.
   */
  async resolveUser(ctx: Context): Promise<AuthUser | null> {
    if (this.currentUser !== null) {
      return this.currentUser
    }

    if (this.userResolver) {
      return this.userResolver(ctx)
    }

    // Try to get user from context
    const user = ctx.get('user') as AuthUser | undefined
    return user ?? null
  }

  /**
   * Check if the user has the given ability.
   */
  async allows(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.check(ability, this.currentUser, ...args)
  }

  /**
   * Check if the user doesn't have the given ability.
   */
  async denies(ability: string, ...args: unknown[]): Promise<boolean> {
    return !(await this.allows(ability, ...args))
  }

  /**
   * Check if the user has any of the given abilities.
   */
  async any(abilities: string[], ...args: unknown[]): Promise<boolean> {
    for (const ability of abilities) {
      if (await this.allows(ability, ...args)) {
        return true
      }
    }
    return false
  }

  /**
   * Check if the user has all of the given abilities.
   */
  async all(abilities: string[], ...args: unknown[]): Promise<boolean> {
    for (const ability of abilities) {
      if (!(await this.allows(ability, ...args))) {
        return false
      }
    }
    return true
  }

  /**
   * Check if the user has none of the given abilities.
   */
  async none(abilities: string[], ...args: unknown[]): Promise<boolean> {
    return !(await this.any(abilities, ...args))
  }

  /**
   * Authorize the ability or throw an exception.
   */
  async authorize(ability: string, ...args: unknown[]): Promise<void> {
    const response = await this.checkResponse(ability, this.currentUser, ...args)

    if (!response.allowed) {
      throw denialToException(response)
    }
  }

  /**
   * Get the authorization response.
   */
  async inspect(ability: string, ...args: unknown[]): Promise<AuthorizationResponse> {
    return this.checkResponse(ability, this.currentUser, ...args)
  }

  /**
   * Check the ability with a specific user.
   */
  async check(ability: string, user: AuthUser | null, ...args: unknown[]): Promise<boolean> {
    const response = await this.checkResponse(ability, user, ...args)
    return response.allowed
  }

  /**
   * Check the ability with a specific user and keep the full response.
   *
   * Policies may answer with a boolean or with a `Response` object. Both
   * shapes are normalized here so no caller has to truthy-test a
   * `{ allowed: false }` object.
   */
  async checkResponse(
    ability: string,
    user: AuthUser | null,
    ...args: unknown[]
  ): Promise<AuthorizationResponse> {
    // Run before callbacks
    for (const beforeCallback of this.beforeCallbacks) {
      const result = await beforeCallback(user, ability, ...args)
      if (typeof result === 'boolean') {
        return this.settle(user, ability, Response[result ? 'allow' : 'deny'](), args)
      }
    }

    // Check for policy
    const model = args[0]
    if (model !== undefined && model !== null) {
      const policyResult = await this.checkPolicy(ability, user, model, args.slice(1))
      if (policyResult !== undefined) {
        return this.settle(user, ability, toAuthorizationResponse(policyResult), args)
      }
    }

    // Check gate
    const gate = this.gates.get(ability)
    if (gate) {
      const result = await gate.callback(user, ...args)
      return this.settle(user, ability, toAuthorizationResponse(result), args)
    }

    // No gate or policy found
    return this.settle(user, ability, Response.deny(), args)
  }

  /**
   * Run after callbacks with the normalized result and return the response.
   */
  protected async settle(
    user: AuthUser | null,
    ability: string,
    response: AuthorizationResponse,
    args: unknown[]
  ): Promise<AuthorizationResponse> {
    await this.runAfterCallbacks(user, ability, response.allowed, args)
    return response
  }

  /**
   * Check a policy for the given ability.
   *
   * The subject may be a class instance (policy resolved via its constructor)
   * or a `[ModelClass, record]` / `['key', record]` tuple. The tuple form is
   * required for plain records returned by the ORM, which carry no constructor
   * information.
   */
  protected async checkPolicy(
    ability: string,
    user: AuthUser | null,
    model: unknown,
    additionalArgs: unknown[]
  ): Promise<boolean | AuthorizationResponse | undefined> {
    let policyKey: unknown
    let subject: unknown = model
    let hasSubject = true

    if (
      Array.isArray(model)
      && model.length === 2
      && (typeof model[0] === 'function' || typeof model[0] === 'string')
    ) {
      policyKey = model[0]
      subject = model[1]
    } else if (typeof model === 'function') {
      // Bare model class — abilities without a record, e.g. can('create', Post)
      policyKey = model
      hasSubject = false
    } else {
      policyKey = model?.constructor
    }

    if (!policyKey) {
      return undefined
    }

    const policyClass = this.policies.get(policyKey)
    if (!policyClass) {
      return undefined
    }

    const policy = this.getPolicyInstance(policyClass)

    // Check before method
    if (policy.before) {
      const beforeResult = await policy.before(user, ability)
      if (typeof beforeResult === 'boolean') {
        return beforeResult
      }
    }

    // Check ability method
    const method = (policy as Record<string, unknown>)[ability]
    if (typeof method === 'function') {
      return hasSubject
        ? method.call(policy, user, subject, ...additionalArgs)
        : method.call(policy, user, ...additionalArgs)
    }

    return undefined
  }

  /**
   * Get or create a policy instance.
   */
  protected getPolicyInstance(policyClass: PolicyClass): Policy {
    let instance = this.policyInstances.get(policyClass)
    if (!instance) {
      instance = new policyClass()
      this.policyInstances.set(policyClass, instance)
    }
    return instance
  }

  /**
   * Run after callbacks.
   */
  protected async runAfterCallbacks(
    user: AuthUser | null,
    ability: string,
    result: boolean,
    args: unknown[]
  ): Promise<void> {
    for (const afterCallback of this.afterCallbacks) {
      await afterCallback(user, ability, result, args)
    }
  }

  /**
   * Get all defined abilities.
   */
  abilities(): string[] {
    return Array.from(this.gates.keys())
  }

  /**
   * Check if an ability is defined.
   */
  has(ability: string): boolean {
    return this.gates.has(ability)
  }

  /**
   * Get the policy for a model.
   */
  getPolicyFor(model: unknown): Policy | undefined {
    const modelConstructor = model?.constructor
    if (!modelConstructor) {
      return undefined
    }

    const policyClass = this.policies.get(modelConstructor)
    if (!policyClass) {
      return undefined
    }

    return this.getPolicyInstance(policyClass)
  }
}

// Global gate instance
let globalGate: Gate | null = null

/**
 * Create a new gate instance.
 */
export function createGate(options?: GateOptions): Gate {
  return new Gate(options)
}

/**
 * Set the global gate instance.
 */
export function setGate(gate: Gate): void {
  globalGate = gate
}

/**
 * Get the global gate instance.
 */
export function getGate(): Gate {
  if (!globalGate) {
    throw new Error('Gate not initialized. Call setGate() first.')
  }
  return globalGate
}

/**
 * Define a gate on the global instance.
 */
export function defineGate(ability: string, callback: GateCallback): void {
  getGate().define(ability, callback)
}

/**
 * Check if the current user can perform an ability.
 */
export async function can(ability: string, ...args: unknown[]): Promise<boolean> {
  return getGate().allows(ability, ...args)
}

/**
 * Check if the current user cannot perform an ability.
 */
export async function cannot(ability: string, ...args: unknown[]): Promise<boolean> {
  return getGate().denies(ability, ...args)
}

/**
 * Authorize or throw.
 */
export async function authorize(ability: string, ...args: unknown[]): Promise<void> {
  return getGate().authorize(ability, ...args)
}
