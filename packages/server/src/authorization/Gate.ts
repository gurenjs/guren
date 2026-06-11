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
import { AuthorizationException } from '../errors'

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
    const allowed = await this.allows(ability, ...args)

    if (!allowed) {
      throw new AuthorizationException(`This action is unauthorized.`)
    }
  }

  /**
   * Get the authorization response.
   */
  async inspect(ability: string, ...args: unknown[]): Promise<AuthorizationResponse> {
    const allowed = await this.check(ability, this.currentUser, ...args)
    return allowed ? Response.allow() : Response.deny()
  }

  /**
   * Check the ability with a specific user.
   */
  async check(ability: string, user: AuthUser | null, ...args: unknown[]): Promise<boolean> {
    // Run before callbacks
    for (const beforeCallback of this.beforeCallbacks) {
      const result = await beforeCallback(user, ability, ...args)
      if (typeof result === 'boolean') {
        await this.runAfterCallbacks(user, ability, result, args)
        return result
      }
    }

    // Check for policy
    const model = args[0]
    if (model !== undefined && model !== null) {
      const policyResult = await this.checkPolicy(ability, user, model, args.slice(1))
      if (policyResult !== undefined) {
        await this.runAfterCallbacks(user, ability, policyResult, args)
        return policyResult
      }
    }

    // Check gate
    const gate = this.gates.get(ability)
    if (gate) {
      const result = await gate.callback(user, ...args)
      await this.runAfterCallbacks(user, ability, result, args)
      return result
    }

    // No gate or policy found
    await this.runAfterCallbacks(user, ability, false, args)
    return false
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
  ): Promise<boolean | undefined> {
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
