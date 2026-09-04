/** Base class for all application events. */
export abstract class Event {
  readonly timestamp: Date = new Date()

  static get eventName(): string {
    return this.name
  }

  get eventName(): string {
    return (this.constructor as typeof Event).eventName
  }
}
