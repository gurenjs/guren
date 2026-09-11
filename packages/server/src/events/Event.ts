/** Base class for all application events. */
export abstract class Event {
  readonly timestamp: Date = new Date()

  /**
   * Stable wire name: queued emits record it and the worker resolves the class
   * back from it. Declare it as a static field to pin the name against a
   * rename or identifier mangling.
   * @default the class name
   */
  static get eventName(): string {
    return this.name
  }

  get eventName(): string {
    return resolveEventName(this.constructor as EventNameCarrier)
  }
}

interface EventNameCarrier {
  name: string
  eventName?: string
}

/**
 * Only an *own* `eventName` counts: statics are inherited, so reading the
 * prototype chain would make every subclass of a pinned event claim its
 * parent's name and take over its listeners. The base class's own entry is the
 * accessor, which answers with the class name.
 */
export function resolveEventName(eventClass: EventNameCarrier): string {
  const own = Object.prototype.hasOwnProperty.call(eventClass, 'eventName')
    ? eventClass.eventName
    : undefined
  return own ?? eventClass.name
}
