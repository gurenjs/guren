/**
 * Prop evaluation for the Inertia protocol's partial reloads and deferred
 * props (https://inertiajs.com/the-protocol, "Prop Evaluation Model").
 * `@guren/testing`'s controller mock resolves through the same function, so a
 * test cannot pass on a prop set production would not send.
 */

import { broadcastChannelsOf, broadcastNameOf, type BroadcastTarget } from '../../broadcasting/event-target'
import { PresenceChannel } from '../../broadcasting/channels/PresenceChannel'
import { PrivateChannel } from '../../broadcasting/channels/PrivateChannel'

const DEFERRED_BRAND = Symbol.for('guren.inertia.deferred')
const ALWAYS_BRAND = Symbol.for('guren.inertia.always')
const LIVE_BRAND = Symbol.for('guren.inertia.live')

const LIVE_OUTERMOST = 'live() must be the outermost prop helper: write live(always(…)) or live(defer(…)), never the other way round.'

export interface AlwaysProp<T> {
  readonly [ALWAYS_BRAND]: true
  readonly value: T
  /** The plain value, so a consumer that serializes shared props before the engine sees them sends the value itself. */
  toJSON(): T
}

/**
 * A prop sent on every response, partial reloads included, whatever the
 * `only`/`except` lists say (Laravel's `Inertia::always()`). The protocol's
 * `errors` is one; a flash-backed shared prop is the usual other, since a
 * flash the partial filter drops is gone with the request.
 */
export function always<T>(value: T): AlwaysProp<T> {
  if (isLiveProp(value)) throw new Error(LIVE_OUTERMOST)
  return Object.freeze({ [ALWAYS_BRAND]: true as const, value, toJSON: () => value })
}

export function isAlwaysProp(value: unknown): value is AlwaysProp<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[ALWAYS_BRAND] === true
}

export interface DeferredProp<T> {
  readonly [DEFERRED_BRAND]: true
  readonly resolve: () => T | Promise<T>
  readonly group: string
}

/**
 * A prop resolved in a follow-up request rather than the initial visit
 * (Laravel's `Inertia::defer()`). The initial response announces the key under
 * `deferredProps[group]` and the client fetches each group with one partial
 * reload; `resolve` runs only on the request that asks for the key.
 */
export function defer<T>(resolve: () => T, group = 'default'): DeferredProp<Awaited<T>> {
  return Object.freeze({
    [DEFERRED_BRAND]: true as const,
    resolve: resolve as () => Awaited<T> | Promise<Awaited<T>>,
    group,
  })
}

export function isDeferredProp(value: unknown): value is DeferredProp<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[DEFERRED_BRAND] === true
}

/** The wire shape of one `liveProps` entry, restated from `@inertiajs/core`, which the server does not depend on. */
export interface LivePropEntry {
  readonly listeners: readonly LiveListener[]
  /** Milliseconds between two reloads of the prop. */
  readonly throttle?: number
}

export interface LiveListener {
  /** Unprefixed, as Inertia expects: the transport adds the prefix back. */
  readonly channel: { readonly name: string; readonly type: LiveChannelType }
  readonly events: readonly string[]
}

export type LiveChannelType = 'public' | 'private' | 'presence'

/** An event named by hand, for a sender that is not an event class. */
export interface LiveListenerInput {
  readonly event: string
  /** Wire names, prefix included: `private-orders.1`, `presence-chat.2`, `announcements`. */
  readonly channel: string | readonly string[]
}

export type LiveEvent = BroadcastTarget

export interface LiveOptions {
  /** Event instances (their channels and name are read off them) or hand-named listeners. */
  readonly on: LiveEvent | LiveListenerInput | readonly (LiveEvent | LiveListenerInput)[]
  /** Milliseconds between two reloads of this prop; the client's default when absent. */
  readonly throttle?: number
}

export interface LiveProp<V> {
  readonly [LIVE_BRAND]: true
  readonly value: V
  readonly entry: LivePropEntry
  /** The value, as `always()` serializes, so props serialized before the engine sees them carry no brand. */
  toJSON(): unknown
}

/**
 * A prop the client reloads whenever one of the given broadcast events
 * arrives (Inertia's live props, RFC 0037). The entry is computed here, so a
 * mistake throws in the action that wrote it. Wraps any other prop input.
 */
export function live<V>(value: V, options: LiveOptions): LiveProp<V> {
  if (isLiveProp(value)) throw new Error('A live prop cannot wrap another live prop.')
  const entry: LivePropEntry = {
    listeners: liveListeners(options.on),
    ...(options.throttle !== undefined ? { throttle: liveThrottle(options.throttle) } : {}),
  }
  return Object.freeze({
    [LIVE_BRAND]: true as const,
    value,
    entry,
    toJSON: () => (isAlwaysProp(value) ? value.toJSON() : value),
  })
}

export function isLiveProp(value: unknown): value is LiveProp<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[LIVE_BRAND] === true
}

function liveThrottle(throttle: number): number {
  if (!Number.isFinite(throttle) || throttle < 0) {
    throw new Error(`A live prop's throttle is milliseconds, a finite number of zero or more; got ${throttle}.`)
  }
  return throttle
}

function isListenerInput(value: LiveEvent | LiveListenerInput): value is LiveListenerInput {
  return typeof (value as LiveEvent).broadcastOn !== 'function'
}

/** Listeners grouped per channel, events deduplicated: the shape the Laravel adapter's `addLiveListener()` sends. */
function liveListeners(on: LiveOptions['on']): LiveListener[] {
  const sources: readonly (LiveEvent | LiveListenerInput)[] = Array.isArray(on) ? on : [on as LiveEvent | LiveListenerInput]
  if (sources.length === 0) throw new Error('A live prop must listen for at least one event.')

  const byChannel = new Map<string, { channel: LiveListener['channel']; events: string[] }>()
  for (const source of sources) {
    if (typeof source === 'function') {
      throw new Error(`live() reads channels off an event instance: pass new ${(source as { name?: string }).name || 'TheEvent'}(…), not the class.`)
    }
    const { event, channels } = isListenerInput(source)
      ? { event: source.event, channels: typeof source.channel === 'string' ? [source.channel] : [...(source.channel ?? [])] }
      : { event: broadcastNameOf(source), channels: broadcastChannelsOf(source) }
    if (typeof event !== 'string' || event === '') throw new Error('A live prop listener needs an event name.')
    if (channels.length === 0) {
      throw new Error(`A live prop listening for "${event}" has no channel: the event broadcasts on none.`)
    }
    for (const wireName of channels) {
      const channel = liveChannel(wireName)
      const key = `${channel.type}:${channel.name}`
      const listener = byChannel.get(key) ?? { channel, events: [] }
      if (!listener.events.includes(event)) listener.events.push(event)
      byChannel.set(key, listener)
    }
  }
  return [...byChannel.values()]
}

/** A Guren wire name as Inertia's `{ name, type }`; the prefixes are the channel classes' own. */
function liveChannel(wireName: string): LiveListener['channel'] {
  if (wireName.startsWith(`${PrivateChannel.PREFIX}encrypted-`)) {
    throw new Error(`Guren has no encrypted channels; "${wireName}" cannot be live.`)
  }
  for (const [prefix, type] of [[PrivateChannel.PREFIX, 'private'], [PresenceChannel.PREFIX, 'presence']] as const) {
    if (wireName.startsWith(prefix)) {
      const name = wireName.slice(prefix.length)
      if (name === '') throw new Error(`"${wireName}" names no channel.`)
      return { name, type }
    }
  }
  if (wireName === '') throw new Error('A live prop channel name is empty.')
  return { name: wireName, type: 'public' }
}

type PlainPropInput<T> = T | DeferredProp<T> | (() => T | Promise<T>)
type BasePropInput<T> = PlainPropInput<T> | AlwaysProp<PlainPropInput<T>>

/** What a controller may pass for a prop the page declares as `T`. */
export type InertiaPropInput<T> = BasePropInput<T> | LiveProp<BasePropInput<T>>

export type InertiaPropsInput<Props> = { [K in keyof Props]: InertiaPropInput<Props[K]> }

/**
 * The value the page receives for one prop input. `always()` recurses: the
 * resolver unwraps it and then runs a deferred or lazy value inside.
 */
export type ResolvedInertiaProp<V> = V extends LiveProp<infer Inner>
  ? ResolvedInertiaProp<Inner>
  : V extends AlwaysProp<infer Inner>
    ? ResolvedInertiaProp<Inner>
    : V extends DeferredProp<unknown>
      ? Awaited<ReturnType<V['resolve']>>
      : V extends () => infer R
        ? Awaited<R>
        : V

export type ResolvedInertiaProps<Props> = { [K in keyof Props]: ResolvedInertiaProp<Props[K]> }

export interface PartialReload {
  /** Top-level prop names listed in `X-Inertia-Partial-Data`; empty means every prop. */
  readonly only: ReadonlySet<string>
  readonly except: ReadonlySet<string>
}

export interface ResolvedInertiaPage {
  readonly props: Record<string, unknown>
  /** Present on a full visit that carried at least one deferred prop. */
  readonly deferredProps?: Record<string, string[]>
  /** The listeners of every live prop the response resolves (all of them on a full visit). */
  readonly liveProps?: Record<string, LivePropEntry>
}

/**
 * A header list as its top-level prop names: `author.name` selects `author`.
 * The prototype client (`@guren/inertia-client/prototype`) answers a fixture
 * with the same rule; the two cannot import each other, so keep them in step.
 */
function propNames(value: string | null): Set<string> {
  const names = (value ?? '').split(',').map((item) => item.trim().split('.')[0])
  return new Set(names.filter((name): name is string => Boolean(name)))
}

/**
 * The partial reload a request asks for, or undefined for a full visit. A
 * partial reload is an Inertia request whose `X-Inertia-Partial-Component`
 * names the component being rendered; a different component (the visit was
 * redirected elsewhere) is a full visit again.
 */
export function readPartialReload(request: Request | undefined, component: string): PartialReload | undefined {
  if (!request?.headers.get('X-Inertia')) return undefined
  if (request.headers.get('X-Inertia-Partial-Component') !== component) return undefined
  return {
    only: propNames(request.headers.get('X-Inertia-Partial-Data')),
    except: propNames(request.headers.get('X-Inertia-Partial-Except')),
  }
}

function isSelected(key: string, partial: PartialReload): boolean {
  if (partial.only.size > 0 && !partial.only.has(key)) return false
  return !partial.except.has(key)
}

/**
 * Starts one prop's value. Through a promise so a resolver that throws
 * synchronously rejects like one that throws later: `Promise.all` then settles
 * every sibling rather than leaving the ones already started unhandled.
 */
function startProp(value: unknown): Promise<unknown> {
  return Promise.resolve()
    .then(() => (isDeferredProp(value) ? value.resolve() : (value as () => unknown)()))
    .then((resolved) => {
      if (isLiveProp(resolved)) throw new Error(LIVE_OUTERMOST)
      return resolved
    })
}

/**
 * The props a response carries under the protocol's evaluation rules: a full
 * visit resolves every prop but the deferred ones, which it announces; a
 * partial reload resolves only the selected props, deferred ones included, and
 * announces nothing; an always prop is sent either way; a lazy prop (a function
 * value) runs only when sent. Resolvers run concurrently, unlike Laravel's.
 */
export async function resolveInertiaProps(
  input: Record<string, unknown>,
  partial: PartialReload | undefined,
): Promise<ResolvedInertiaPage> {
  const props: Record<string, unknown> = {}
  const deferredProps: Record<string, string[]> = {}
  const liveProps: Record<string, LivePropEntry> = {}
  const pending: Promise<void>[] = []

  for (const [key, given] of Object.entries(input)) {
    const liveProp = isLiveProp(given) ? given : undefined
    const raw = liveProp ? liveProp.value : given
    const alwaysProp = isAlwaysProp(raw)
    const value = alwaysProp ? raw.value : raw
    const deferred = isDeferredProp(value)
    if (partial) {
      if (!alwaysProp && !isSelected(key, partial)) continue
      if (liveProp) liveProps[key] = liveProp.entry
    } else {
      // A deferred prop's listeners too: the client must hold them before its request returns.
      if (liveProp) liveProps[key] = liveProp.entry
      if (deferred) {
        ;(deferredProps[value.group] ??= []).push(key)
        continue
      }
    }
    if (deferred || typeof value === 'function') {
      // The key is claimed now so the props keep their declared order.
      props[key] = undefined
      pending.push(startProp(value).then((resolved) => { props[key] = resolved }))
    } else {
      props[key] = value
    }
  }

  if (pending.length > 0) await Promise.all(pending)
  return {
    props,
    ...(Object.keys(deferredProps).length > 0 ? { deferredProps } : {}),
    ...(Object.keys(liveProps).length > 0 ? { liveProps } : {}),
  }
}
