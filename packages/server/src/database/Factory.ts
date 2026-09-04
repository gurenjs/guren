type StateDefinition<T> = Partial<T> | ((attributes: Partial<T>) => Partial<T>)

export abstract class BaseFactory<T> {
  private _sequence = 0
  private _states: Map<string, StateDefinition<T>> = new Map()
  private _activeStates: string[] = []
  private _afterCreatingCallbacks: Array<(model: T) => void | Promise<void>> = []
  private _afterMakingCallbacks: Array<(model: T) => void | Promise<void>> = []

  protected get sequence(): number {
    return this._sequence
  }

  /** The model's default attributes. */
  abstract definition(): Partial<T>

  /** Override to persist. */
  protected async persist(attributes: Partial<T>): Promise<T> {
    return attributes as T
  }

  state(name: string, state: StateDefinition<T>): this {
    this._states.set(name, state)
    return this
  }

  withState(name: string): this {
    if (!this._states.has(name)) {
      throw new Error(`State "${name}" is not defined`)
    }
    this._activeStates.push(name)
    return this
  }

  withStates(...names: string[]): this {
    for (const name of names) {
      this.withState(name)
    }
    return this
  }

  afterCreating(callback: (model: T) => void | Promise<void>): this {
    this._afterCreatingCallbacks.push(callback)
    return this
  }

  afterMaking(callback: (model: T) => void | Promise<void>): this {
    this._afterMakingCallbacks.push(callback)
    return this
  }

  /** Build without persisting. */
  make(overrides: Partial<T> = {}): T {
    this._sequence++

    let attributes = { ...this.definition() }

    for (const stateName of this._activeStates) {
      const state = this._states.get(stateName)!
      if (typeof state === 'function') {
        attributes = { ...attributes, ...state(attributes) }
      } else {
        attributes = { ...attributes, ...state }
      }
    }

    attributes = { ...attributes, ...overrides }

    const model = attributes as T

    for (const callback of this._afterMakingCallbacks) {
      callback(model)
    }

    return model
  }

  makeMany(count: number, overrides: Partial<T> = {}): T[] {
    const models: T[] = []
    for (let i = 0; i < count; i++) {
      models.push(this.make(overrides))
    }
    return models
  }

  async create(overrides: Partial<T> = {}): Promise<T> {
    const attributes = this.make(overrides)
    const model = await this.persist(attributes as Partial<T>)

    for (const callback of this._afterCreatingCallbacks) {
      await callback(model)
    }

    return model
  }

  async createMany(count: number, overrides: Partial<T> = {}): Promise<T[]> {
    const models: T[] = []
    for (let i = 0; i < count; i++) {
      models.push(await this.create(overrides))
    }
    return models
  }

  resetSequence(): this {
    this._sequence = 0
    return this
  }

  clearStates(): this {
    this._activeStates = []
    return this
  }

  /** A new factory instance with fresh state. */
  fresh(): this {
    const factory = new (this.constructor as new () => this)()
    return factory
  }
}

export { BaseFactory as Factory }

export function defineFactory<T>(
  definition: (sequence: number) => Partial<T>,
  persist?: (attributes: Partial<T>) => Promise<T>
): BaseFactory<T> {
  class InlineFactory extends BaseFactory<T> {
    private defFn = definition

    definition(): Partial<T> {
      return this.defFn(this.sequence)
    }

    protected async persist(attributes: Partial<T>): Promise<T> {
      if (persist) {
        return persist(attributes)
      }
      return attributes as T
    }
  }

  return new InlineFactory()
}
