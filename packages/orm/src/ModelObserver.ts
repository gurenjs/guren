import type { HookName } from './hooks'
import type { PlainObject } from './Model'

/**
 * Lifecycle hook logic extracted into a class, registered with
 * `User.observe(UserObserver)`.
 */
export interface ModelObserver {
  creating?(data: PlainObject): void | Promise<void> | false | Promise<false>
  created?(data: PlainObject): void | Promise<void>
  updating?(data: PlainObject): void | Promise<void> | false | Promise<false>
  updated?(data: PlainObject): void | Promise<void>
  deleting?(data: PlainObject): void | Promise<void> | false | Promise<false>
  deleted?(data: PlainObject): void | Promise<void>
  saving?(data: PlainObject): void | Promise<void> | false | Promise<false>
  saved?(data: PlainObject): void | Promise<void>
}

export type ModelObserverConstructor = new () => ModelObserver

/** Returns false as soon as an observer aborts the operation. */
export async function executeObservers(
  observers: ModelObserver[] | undefined,
  name: HookName,
  data: PlainObject,
): Promise<boolean> {
  if (!observers || observers.length === 0) return true

  for (const observer of observers) {
    const fn = observer[name]
    if (typeof fn === 'function') {
      const result = await fn.call(observer, data)
      if (result === false) return false
    }
  }

  return true
}
