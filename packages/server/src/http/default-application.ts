import type { Application } from './Application'
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

/** @internal Application constructor only. A second construction beside a live default is what sets the flag. */
export function adoptDefaultApplication(app: Application): void {
  if (current && current !== app && peekContainer() === current.container) {
    ambiguous = true
  }
  current = app
  setContainer(app.container)
}

/** Opt-in override for a process that constructs several and wants the ambient one chosen, not last. */
export function useAsDefaultApplication(app: Application): void {
  current = app
  ambiguous = false
  setContainer(app.container)
}

/** @internal Test seam; replaces every `set*(undefined)` and `clear*()` reset. */
export function resetDefaultApplication(): void {
  current = null
  ambiguous = false
  clearContainer()
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

function warnIfAmbiguous(): void {
  if (ambiguous) {
    warnOnce('ambient-application-ambiguous', AMBIGUOUS_WARNING)
  }
}
