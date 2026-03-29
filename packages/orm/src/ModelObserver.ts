import type { HookName } from './hooks'
import type { PlainObject } from './Model'

/**
 * Base interface for model observers.
 *
 * Observers allow extracting lifecycle hook logic into dedicated classes.
 * Each method corresponds to a model lifecycle event and is optional.
 *
 * @example
 * class UserObserver implements ModelObserver {
 *   async creating(data) { data.slug = slugify(data.name) }
 *   async created(data) { await sendWelcomeEmail(data) }
 * }
 *
 * User.observe(UserObserver)
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

/**
 * Execute all registered observers for a given hook.
 * Returns false if any observer aborts the operation.
 */
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
