import { always, defer, live, type InertiaPropInput, type ResolvedInertiaProp } from '../../src/mvc/inertia/props'

/**
 * A type-only fixture (RFC 0037 §6): `bun run typecheck` is the assertion.
 * `live()` wraps every other prop input, a prop wrapping `live()` is no input,
 * the helpers keep accepting nullable, `unknown` and generic values, and the
 * resolved type recurses through `always()` as the resolver does.
 */

type Equal<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false
const assert = <T extends true>(): T | undefined => undefined

const on = { on: { event: 'OrderUpdated', channel: 'private-orders.1' } }

export const accepted: InertiaPropInput<number>[] = [
  1,
  defer(() => 1),
  () => Promise.resolve(1),
  always(1),
  always(defer(() => 1)),
  always(() => 1),
  live(1, on),
  live(async () => 1, on),
  live(defer(() => 1), on),
  live(always(defer(() => 1)), on),
]

// @ts-expect-error the wrapped value must match the page's type
export const wrongInner: InertiaPropInput<number> = live('one', on)
// @ts-expect-error a live prop inside a live prop
export const nested: InertiaPropInput<number> = live(live(1, on), on)
// @ts-expect-error live() must be outermost
export const liveInsideAlways: InertiaPropInput<number> = always(live(1, on))
// @ts-expect-error a deferred callback may not return a live prop
export const liveInsideDefer: InertiaPropInput<number> = defer(() => live(1, on))

declare const maybe: string | undefined
declare const nullable: { id: number } | null
declare const anything: unknown
export const optional: InertiaPropInput<string | undefined>[] = [always(maybe), defer(() => maybe), live(always(maybe), on)]
export const helpers = [always(nullable), always(anything), always(null), always(undefined), defer(() => anything), defer(() => null)]
export function passThrough<T>(value: T) {
  return [always(value), defer(() => value), live(value, on)]
}

assert<Equal<ResolvedInertiaProp<ReturnType<typeof live<number>>>, number>>()
assert<Equal<ResolvedInertiaProp<typeof accepted[number]>, number>>()
assert<Equal<ResolvedInertiaProp<ReturnType<typeof always<() => Promise<string>>>>, string>>()
assert<Equal<ResolvedInertiaProp<{ id: number }>, { id: number }>>()
