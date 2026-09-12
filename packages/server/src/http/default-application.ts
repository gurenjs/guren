import type { Application } from './Application'
import type { ServiceBindings } from '../container/bindings'
import { type Container, clearContainer, getContainer, peekContainer, setContainer } from '../container/Container'
import { warnOnce } from '../support/warn-once'

/**
 * The ambient Application (RFC 0023 §3), what a helper with no handle to pass
 * (`encrypt()`, `t()`, `Job.dispatch()`, `resolve()`) resolves from.
 * Last-constructed wins, which a sequential `bun test` process needs; a second
 * construction beside a live default is the hazard, so it marks the choice
 * ambiguous and the next ambient call warns once.
 */
let current: Application | null = null
let ambiguous = false

const AMBIGUOUS_WARNING =
  '[guren] Two Applications exist in this process, and an ambient helper resolved a service from ' +
  'the most recently constructed one. Call useAsDefaultApplication(app) to choose, or resolve ' +
  'explicitly: container.make(key), this.make(key) in a controller, job or command, or createFacades(container).'

/** @internal Application constructor only. Displacing a still-ambient app is what makes the choice ambiguous. */
export function adoptDefaultApplication(app: Application): void {
  const displaces = Boolean(current && current !== app && peekContainer() === current.container)
  setDefault(app, ambiguous || displaces)
}

/** Opt-in override for a process that constructs several and wants the ambient one chosen, not last. */
export function useAsDefaultApplication(app: Application): void {
  setDefault(app, false)
}

/** @internal Test seam: empties the ambient slot and the ambiguity flag. */
export function resetDefaultApplication(): void {
  current = null
  ambiguous = false
  clearContainer()
}

function setDefault(app: Application, nextAmbiguous: boolean): void {
  current = app
  ambiguous = nextAmbiguous
  setContainer(app.container)
}

/**
 * The most recently constructed Application; `null` before any exists, and
 * `null` again once `setContainer()` handed the ambient slot a container that
 * belongs to no Application.
 */
export function defaultApplication(): Application | null {
  warnIfAmbiguous()
  if (!current || peekContainer() !== current.container) {
    return null
  }
  return current
}

/** The default application's container; throws the same "not initialized" error the getters throw. */
export function defaultContainer(): Container {
  warnIfAmbiguous()
  return getContainer()
}

/** `defaultContainer()` for a caller with a fallback of its own: null instead of the throw. */
export function ambientContainer(): Container | null {
  warnIfAmbiguous()
  return peekContainer()
}

/**
 * The binding the default application holds under `key`, or undefined when
 * there is no default application or it binds nothing there. Every functional
 * helper reads through this before its module slot (RFC 0023 §3).
 */
export function ambientBinding<K extends keyof ServiceBindings>(key: K): ServiceBindings[K] | undefined {
  return ambientContainer()?.makeOptional(key)
}

/** Resolve `key` from the default application's container. */
export function resolve<T = unknown>(key: string): T {
  return defaultContainer().make<T>(key)
}

function warnIfAmbiguous(): void {
  if (ambiguous) {
    warnOnce('ambient-application-ambiguous', AMBIGUOUS_WARNING)
  }
}
