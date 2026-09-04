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
import { getAuthContext } from '../auth/context'

/** Response builder for authorization checks. */
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

/** Narrow a policy/gate return value to an `AuthorizationResponse`. */
export function isAuthorizationResponse(value: unknown): value is AuthorizationResponse {
  return (
    typeof value === 'object'
    && value !== null
    && typeof (value as AuthorizationResponse).allowed === 'boolean'
  )
}

/**
 * A `{ allowed: false }` object is truthy, so deciding access from a raw return
 * value fails open. Every path routes through here, and unknown shapes deny.
 */
function toAuthorizationResponse(value: unknown): AuthorizationResponse {
  if (isAuthorizationResponse(value)) {
    return value
  }
  return value === true ? Response.allow() : Response.deny()
}

/** Honours `denyWithStatus()` / `denyAsNotFound()` so a policy can hide a record as a 404. */
export function denialToException(response: AuthorizationResponse): Error {
  const message = response.message ?? 'This action is unauthorized.'
  const status = (response as AuthorizationResponse & { status?: number }).status

  if (typeof status === 'number' && status !== 403) {
    return new HttpException(status, message)
  }

  return new AuthorizationException(message)
}

/** Authorization gate for defining and checking abilities. */
export class Gate {
  protected gates: Map<string, GateDefinition> = new Map()

  protected policies: Map<unknown, PolicyClass> = new Map()

  protected policyInstances: Map<PolicyClass, Policy> = new Map()

  protected beforeCallbacks: GateBeforeCallback[] = []

  protected afterCallbacks: Array<
    (user: AuthUser | null, ability: string, result: boolean, args: unknown[]) => void | Promise<void>
  > = []

  protected userResolver?: (ctx: Context) => AuthUser | null | Promise<AuthUser | null>

  protected currentUser: AuthUser | null = null

  constructor(options: GateOptions = {}) {
    this.userResolver = options.userResolver
  }

  define<Args extends unknown[]>(ability: string, callback: GateCallback<Args>): this {
    this.gates.set(ability, { callback })
    return this
  }

  policy(modelClass: unknown, policyClass: PolicyClass): this {
    this.policies.set(modelClass, policyClass)
    return this
  }

  /** Return true to allow, false to deny, undefined to continue. */
  before<Args extends unknown[]>(callback: GateBeforeCallback<Args>): this {
    this.beforeCallbacks.push(callback)
    return this
  }

  after(
    callback: (user: AuthUser | null, ability: string, result: boolean, args: unknown[]) => void | Promise<void>
  ): this {
    this.afterCallbacks.push(callback)
    return this
  }

  forUser(user: AuthUser | null): this {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)),
      this
    ) as this
    clone.currentUser = user
    return clone
  }

  async resolveUser(ctx: Context): Promise<AuthUser | null> {
    if (this.currentUser !== null) {
      return this.currentUser
    }

    if (this.userResolver) {
      return this.userResolver(ctx)
    }

    // An attached auth context's answer is authoritative, including null:
    // falling back to ctx.get('user') would resurrect a principal that
    // authentication just rejected (RFC 0016). The legacy fallback survives
    // only for requests with no auth context at all.
    const auth = getAuthContext(ctx)
    if (auth && typeof auth.user === 'function') {
      return ((await auth.user()) as AuthUser | null) ?? null
    }

    const user = ctx.get('user') as AuthUser | undefined
    return user ?? null
  }

  async allows(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.check(ability, this.currentUser, ...args)
  }

  async denies(ability: string, ...args: unknown[]): Promise<boolean> {
    return !(await this.allows(ability, ...args))
  }

  async any(abilities: string[], ...args: unknown[]): Promise<boolean> {
    for (const ability of abilities) {
      if (await this.allows(ability, ...args)) {
        return true
      }
    }
    return false
  }

  async all(abilities: string[], ...args: unknown[]): Promise<boolean> {
    for (const ability of abilities) {
      if (!(await this.allows(ability, ...args))) {
        return false
      }
    }
    return true
  }

  async none(abilities: string[], ...args: unknown[]): Promise<boolean> {
    return !(await this.any(abilities, ...args))
  }

  async authorize(ability: string, ...args: unknown[]): Promise<void> {
    const response = await this.checkResponse(ability, this.currentUser, ...args)

    if (!response.allowed) {
      throw denialToException(response)
    }
  }

  async inspect(ability: string, ...args: unknown[]): Promise<AuthorizationResponse> {
    return this.checkResponse(ability, this.currentUser, ...args)
  }

  async check(ability: string, user: AuthUser | null, ...args: unknown[]): Promise<boolean> {
    const response = await this.checkResponse(ability, user, ...args)
    return response.allowed
  }

  /** Like check(), but keeps the full response instead of just `allowed`. */
  async checkResponse(
    ability: string,
    user: AuthUser | null,
    ...args: unknown[]
  ): Promise<AuthorizationResponse> {
    // Only `undefined` means "keep checking" — anything else is an answer, and
    // a `Response.deny()` object read as "not a boolean" would drop the denial.
    for (const beforeCallback of this.beforeCallbacks) {
      const result = await beforeCallback(user, ability, ...args)
      if (result !== undefined) {
        return this.settle(user, ability, toAuthorizationResponse(result), args)
      }
    }

    const model = args[0]
    if (model !== undefined && model !== null) {
      const policyResult = await this.checkPolicy(ability, user, model, args.slice(1))
      if (policyResult !== undefined) {
        return this.settle(user, ability, toAuthorizationResponse(policyResult), args)
      }
    }

    const gate = this.gates.get(ability)
    if (gate) {
      const result = await gate.callback(user, ...args)
      return this.settle(user, ability, toAuthorizationResponse(result), args)
    }

    return this.settle(user, ability, Response.deny(), args)
  }

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
   * The subject may be a class instance (policy resolved via its constructor)
   * or a `[ModelClass, record]` / `['key', record]` tuple — the tuple form is
   * required for plain ORM records, which carry no constructor information.
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

    // Only `undefined` continues to the ability method.
    if (policy.before) {
      const beforeResult = await policy.before(user, ability)
      if (beforeResult !== undefined) {
        return beforeResult
      }
    }

    const method = (policy as Record<string, unknown>)[ability]
    if (typeof method === 'function') {
      return hasSubject
        ? method.call(policy, user, subject, ...additionalArgs)
        : method.call(policy, user, ...additionalArgs)
    }

    return undefined
  }

  protected getPolicyInstance(policyClass: PolicyClass): Policy {
    let instance = this.policyInstances.get(policyClass)
    if (!instance) {
      instance = new policyClass()
      this.policyInstances.set(policyClass, instance)
    }
    return instance
  }

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

  abilities(): string[] {
    return Array.from(this.gates.keys())
  }

  has(ability: string): boolean {
    return this.gates.has(ability)
  }

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

let globalGate: Gate | null = null

export function createGate(options?: GateOptions): Gate {
  return new Gate(options)
}

export function setGate(gate: Gate): void {
  globalGate = gate
}

export function getGate(): Gate {
  if (!globalGate) {
    throw new Error('Gate not initialized. Call setGate() first.')
  }
  return globalGate
}

/** Define a gate on the global instance. */
export function defineGate(ability: string, callback: GateCallback): void {
  getGate().define(ability, callback)
}

export async function can(ability: string, ...args: unknown[]): Promise<boolean> {
  return getGate().allows(ability, ...args)
}

export async function cannot(ability: string, ...args: unknown[]): Promise<boolean> {
  return getGate().denies(ability, ...args)
}

export async function authorize(ability: string, ...args: unknown[]): Promise<void> {
  return getGate().authorize(ability, ...args)
}
