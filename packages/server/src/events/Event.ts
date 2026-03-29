/**
 * Base class for all application events.
 *
 * @example
 * ```ts
 * class UserRegistered extends Event {
 *   constructor(
 *     public readonly userId: string,
 *     public readonly email: string
 *   ) {
 *     super()
 *   }
 * }
 *
 * // Emit the event
 * await events.emit(new UserRegistered('123', 'user@example.com'))
 * ```
 */
export abstract class Event {
  /**
   * Timestamp when the event was created.
   */
  readonly timestamp: Date = new Date()

  /**
   * Get the event name (class name by default).
   * Override this to customize the event name.
   */
  static get eventName(): string {
    return this.name
  }

  /**
   * Get the event name from an instance.
   */
  get eventName(): string {
    return (this.constructor as typeof Event).eventName
  }
}
