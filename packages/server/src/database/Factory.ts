/**
 * State definition for factories.
 */
type StateDefinition<T> = Partial<T> | ((attributes: Partial<T>) => Partial<T>)

/**
 * Abstract base class for model factories.
 */
export abstract class BaseFactory<T> {
  private _sequence = 0
  private _states: Map<string, StateDefinition<T>> = new Map()
  private _activeStates: string[] = []
  private _afterCreatingCallbacks: Array<(model: T) => void | Promise<void>> = []
  private _afterMakingCallbacks: Array<(model: T) => void | Promise<void>> = []

  /**
   * Get the current sequence number.
   */
  protected get sequence(): number {
    return this._sequence
  }

  /**
   * Define the default attributes for the model.
   */
  abstract definition(): Partial<T>

  /**
   * Create a model instance (to be overridden for persistence).
   */
  protected async persist(attributes: Partial<T>): Promise<T> {
    // Default implementation just returns the attributes
    // Override this method to actually save to database
    return attributes as T
  }

  /**
   * Define a state.
   */
  state(name: string, state: StateDefinition<T>): this {
    this._states.set(name, state)
    return this
  }

  /**
   * Apply a state to the factory.
   */
  withState(name: string): this {
    if (!this._states.has(name)) {
      throw new Error(`State "${name}" is not defined`)
    }
    this._activeStates.push(name)
    return this
  }

  /**
   * Apply multiple states.
   */
  withStates(...names: string[]): this {
    for (const name of names) {
      this.withState(name)
    }
    return this
  }

  /**
   * Register a callback to run after creating.
   */
  afterCreating(callback: (model: T) => void | Promise<void>): this {
    this._afterCreatingCallbacks.push(callback)
    return this
  }

  /**
   * Register a callback to run after making.
   */
  afterMaking(callback: (model: T) => void | Promise<void>): this {
    this._afterMakingCallbacks.push(callback)
    return this
  }

  /**
   * Make a model instance without persisting.
   */
  make(overrides: Partial<T> = {}): T {
    this._sequence++

    let attributes = { ...this.definition() }

    // Apply states
    for (const stateName of this._activeStates) {
      const state = this._states.get(stateName)!
      if (typeof state === 'function') {
        attributes = { ...attributes, ...state(attributes) }
      } else {
        attributes = { ...attributes, ...state }
      }
    }

    // Apply overrides
    attributes = { ...attributes, ...overrides }

    const model = attributes as T

    // Run afterMaking callbacks. make() is synchronous, so an async
    // callback finishes after the model has already been returned.
    for (const callback of this._afterMakingCallbacks) {
      void callback(model)
    }

    return model
  }

  /**
   * Make multiple model instances without persisting.
   */
  makeMany(count: number, overrides: Partial<T> = {}): T[] {
    const models: T[] = []
    for (let i = 0; i < count; i++) {
      models.push(this.make(overrides))
    }
    return models
  }

  /**
   * Create and persist a model instance.
   */
  async create(overrides: Partial<T> = {}): Promise<T> {
    const attributes = this.make(overrides)
    const model = await this.persist(attributes as Partial<T>)

    // Run afterCreating callbacks
    for (const callback of this._afterCreatingCallbacks) {
      await callback(model)
    }

    return model
  }

  /**
   * Create and persist multiple model instances.
   */
  async createMany(count: number, overrides: Partial<T> = {}): Promise<T[]> {
    const models: T[] = []
    for (let i = 0; i < count; i++) {
      models.push(await this.create(overrides))
    }
    return models
  }

  /**
   * Reset the sequence counter.
   */
  resetSequence(): this {
    this._sequence = 0
    return this
  }

  /**
   * Clear active states.
   */
  clearStates(): this {
    this._activeStates = []
    return this
  }

  /**
   * Create a new factory instance with fresh state.
   */
  fresh(): this {
    const factory = new (this.constructor as new () => this)()
    return factory
  }
}

/**
 * Alias for BaseFactory.
 */
export { BaseFactory as Factory }

/**
 * Helper to create a simple factory with a definition function.
 */
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
