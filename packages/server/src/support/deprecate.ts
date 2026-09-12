import { warnOnce } from './warn-once'

/** The release these shims were deprecated in, and the one that removes them (RFC 0023 Part 3). */
const SINCE = '2.23.0'
const REMOVED_IN = '3.0.0'

/** RFC 0023 §5: the module-level service slots, split by direction. */
export const GLOBAL_SERVICE_SETTERS = 'global-service-setters'
export const GLOBAL_SERVICE_GETTERS = 'global-service-getters'

const SETTER_REPLACEMENT =
  "Bind the service on the owning app's container instead — container.instance(key, value) from a "
  + 'service provider. createApp({ inertia }) covers the two Inertia options, and '
  + 'shareInertiaProps(fn, container) the shared props.'

const GETTER_REPLACEMENT =
  'Resolve from the container that owns the call — this.make(key) in a controller, job or command, '
  + 'getRequestContainer(ctx).make(key) in middleware, defaultContainer().make(key) elsewhere.'

/**
 * @internal The deprecation policy's warning format
 * (`contributing/deprecation-policy.md`), keyed per symbol so one deprecated
 * call does not silence its siblings.
 */
export function warnDeprecated(
  id: string,
  symbol: string,
  replacement: string,
  versions: { since: string; removedIn: string } = { since: SINCE, removedIn: REMOVED_IN },
): void {
  warnOnce(
    `${id}:${symbol}`,
    `[guren] Deprecation (${id}): ${symbol}() is deprecated\n`
      + `  since ${versions.since}, will be removed in ${versions.removedIn}.\n`
      + `  ${replacement}`,
  )
}

/** @internal */
export function warnDeprecatedSetter(symbol: string): void {
  warnDeprecated(GLOBAL_SERVICE_SETTERS, symbol, SETTER_REPLACEMENT)
}

/** @internal */
export function warnDeprecatedGetter(symbol: string): void {
  warnDeprecated(GLOBAL_SERVICE_GETTERS, symbol, GETTER_REPLACEMENT)
}
