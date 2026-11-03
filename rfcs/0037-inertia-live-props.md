# RFC: Inertia Live Props over Guren Broadcasting

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-11-03
**Status:** Accepted (2026-11-03; the standard two-week discussion window was
shortened by the deciding maintainer, after a Codex review whose eleven
findings are addressed in PR #1299. The open questions stay open for the
implementation PRs to settle.)

> Inertia 3.11.0 refreshes a page prop with a partial reload whenever a
> broadcast event names it. The server lists, per prop, the channels and event
> names to listen for under a new `liveProps` key of the page object, and the
> client subscribes through a *transport* the app passes to `createInertiaApp()`.
> This RFC adds the Guren half of both sides: a `live()` prop helper that reads
> channels and the event name off a broadcastable event, a transport in
> `@guren/inertia-client` that speaks Guren's own `/broadcasting/socket` protocol
> (no Laravel Echo, no Pusher), the one-field frame change that transport needs,
> a socket id so a request can skip its own broadcast, and the type and
> `guren check` changes that keep `live(defer(…))` honest.

## Problem

A page that shows server state which other people change (an order's status,
a ticket's comments, a dashboard counter) goes stale the moment it renders.
Guren apps have two ways to keep it fresh today, and both put the work on the
page author.

**Polling.** `router.reload({ only: ['order'] })` on an interval. Every open
tab asks the server every few seconds whether anything changed, whether it did
or not, and the interval is a guess at how fresh the page must be.

**A channel subscription in the component.** `createUseChannel()`
(`packages/inertia-client/src/channel.ts`) opens an `EventSource` per channel,
and the component calls `router.reload()` from the handler:

```tsx
const useChannel = createUseChannel<ChannelEvents>()

export default function Show({ order }: Props) {
  useEffect(() => {
    const channel = useChannel(`private-orders.${order.id}`)
    channel.on('OrderUpdated', () => router.reload({ only: ['order'] }))
    return () => channel.close()
  }, [order.id])
  // …
}
```

This works, and every page that does it rebuilds the same machinery by hand:
the channel name is restated in the component though the controller already
knows it, two events a few milliseconds apart send two reloads, a hidden tab
keeps reloading, a reload already in flight can be overwritten by an older
response, and nothing refreshes the prop after the stream reconnects, so the
events that fired while it was down are lost. Each `useChannel()` also holds
its own HTTP connection, and on HTTP/1.1 a browser allows six per origin, so a
handful of live widgets stalls every other request the page makes.

Inertia 3.11.0 (inertiajs/inertia#3232, inertiajs/inertia-laravel#901) solves
all of this once, in the client. What it needs from the framework is the
server-side declaration (`liveProps` on the page object) and a transport that
can subscribe to a channel. Guren has neither: its props helpers stop at
`always()` and `defer()` (`packages/server/src/mvc/inertia/props.ts`), and its
broadcasting has no client a transport could wrap.

### What Inertia 3.11.0 ships

The parts this RFC depends on, read from the merged sources of
`@inertiajs/core@3.11.0` (`live.ts`, `types.ts`, `socketId.ts`) and the Laravel
adapter's `HasLiveUpdates.php` and `PropsResolver.php`:

- **The page object** gains `liveProps?: Record<string, LiveProp>`, keyed by
  prop path:

  ```ts
  type LiveChannelType = 'public' | 'private' | 'presence' | 'encrypted-private'
  type LiveChannel = { name: string; type: LiveChannelType | (string & {}); params?: Record<string, unknown> }
  type LiveListener = { channel: LiveChannel; events: string[] }
  type LiveProp = { listeners: LiveListener[]; throttle?: number }
  ```

  Channel names arrive *unprefixed*: the type travels separately and the
  transport applies the broadcaster's own prefix (`private-`, `presence-`).
  A channel and its events stay paired so the client never subscribes to a
  cross product.

- **The adapter's emission rule.** A full visit carries an entry for every
  live prop, including the ones excluded from the response (deferred, optional),
  because "excluding a prop from the initial response never removes its live
  listeners". A partial reload carries entries only for the props it resolved
  (selected by `only`/`except`, or `always`), and the client merges them over
  the entries it holds (`response.ts`).

- **The transport seam**, passed as `createInertiaApp({ live })`:

  ```ts
  interface LiveTransport {
    subscribe(channel: LiveChannel, event: string, handler: (payload: unknown) => void): VoidFunction
    socketId?: () => string | null | undefined
    onStatusChange?(callback: (connected: boolean) => void): VoidFunction
  }
  // or `subscribeToChannel(channel, handler)` plus `eventName?(payload)`, for a
  // broadcaster with no event names (Action Cable).
  type LiveOptions = { transport: AnyLiveTransport; throttle?: number; pauseWhenHidden?: boolean }
  ```

  `subscribe()` runs during a page swap and must not throw for anything
  recoverable. The client subscribes before it unsubscribes, so a transport
  that reference-counts channels keeps a shared channel open across a swap.

- **Client behaviour** the server never has to know about: events within 32 ms
  join one `router.reload({ only })`; each prop is throttled (1000 ms by
  default, per-prop `throttle` from the server); reloads wait while the tab is
  hidden (`pauseWhenHidden`, default on); a prop a request already in flight
  claims waits for it; an optional prop the page never loaded is never loaded
  by an event; a reported reconnect refreshes every live prop; a `live` router
  event may cancel one update.

- **Socket ids.** When the transport reports `socketId()`, Inertia sends it as
  `X-Socket-Id` on every same-origin request its own HTTP client makes, unless
  the request already sets the header or the app registered its own resolver
  (`socketId.resolveUsing()`). It drops any event whose payload carries
  `__inertia.socketId` equal to its own.

- **Values in the event** (`__inertia.props`): when a payload carries a value
  for a prop the subscription feeds, the client writes it into the page and
  makes no reload. There is no option to turn this off; any payload with that
  key takes effect. This RFC does not adopt the mode and has the transport
  remove the key (§3); see [Values carried by the event](#values-carried-by-the-event).

- **Merge props cannot be live**; the Laravel adapter throws.

## Proposed Solution

The design keeps one rule in each place it could drift: one function decides
which channels and which event name an event is broadcast as, and both the
sender and `live()` call it; one resolver decides which `liveProps` a response
carries, and the engine, the testing mock and the docs all go through it.

### 1. `live()` on the server

```ts
import { defer, live } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { OrderUpdated } from '@/app/Events/OrderUpdated'
import { ActivityLogged } from '@/app/Events/ActivityLogged'

export class OrderController extends Controller {
  async show() {
    const order = this.model(Order)
    return this.inertia(pages.orders.Show, {
      order: live(() => OrderResource.make(order), { on: new OrderUpdated(order.id) }),
      activity: live(defer(() => order.activity()), {
        on: new ActivityLogged(order.id),
        throttle: 4000,
      }),
    })
  }
}
```

The signature, in `packages/server/src/mvc/inertia/props.ts` beside `always()`
and `defer()`. `live` and `isLiveProp` join their entry in the explicit export
list of `packages/server/src/index.ts`, and the types join the `export type`
list beside it; `@guren/core` forwards both through its `export *`:

```ts
const LIVE_BRAND = Symbol.for('guren.inertia.live')

/** A broadcast event as `live()` reads it: the same shape `BroadcastableEvent` declares. */
export type LiveEvent = Pick<BroadcastableEvent, 'broadcastOn' | 'broadcastAs'> & { readonly eventName?: string }

/** An event named by hand, for a sender that is not an event class. */
export interface LiveListenerInput {
  readonly event: string
  /** Wire names, prefix included: `private-orders.1`, `presence-chat.2`, `announcements`. */
  readonly channel: string | readonly string[]
}

export interface LiveOptions {
  readonly on: LiveEvent | LiveListenerInput | readonly (LiveEvent | LiveListenerInput)[]
  /** Milliseconds between two reloads of this prop; the client's default when absent. */
  readonly throttle?: number
}

/** The wire shape of one `liveProps` entry, restated from `@inertiajs/core`, which the server does not depend on. */
export interface LivePropEntry {
  readonly listeners: readonly {
    readonly channel: { readonly name: string; readonly type: 'public' | 'private' | 'presence' }
    readonly events: readonly string[]
  }[]
  readonly throttle?: number
}

/** The controller-side wrapper. Its `toJSON()` is the value's; the entry is built apart from it. */
export interface LiveProp<V> {
  readonly [LIVE_BRAND]: true
  readonly value: V
  readonly entry: LivePropEntry
  toJSON(): unknown
}

export function live<V>(value: V, options: LiveOptions): LiveProp<V>
export function isLiveProp(value: unknown): value is LiveProp<unknown>
```

`live()` computes its entry when it is called, not when the response is
written, so a mistake throws inside the controller action with a stack that
points at it:

- an `on` list that is empty, an event whose `broadcastOn()` returns no
  channels, or a `LiveListenerInput` with no channel;
- an `encrypted-private` or other unknown prefix (Guren has no such channel);
- a `value` that is itself a `LiveProp` (one `live()` per prop).

`toJSON()` returns the inner value's own `toJSON` result or the value, as
`always()` does, so a consumer that serializes shared props before the engine
sees them sends the value rather than the brand.

#### Reading an event

`on` takes an event **instance**. Guren's `BroadcastableEvent.broadcastOn()` is
an instance method that reads the event's own fields (`private-orders.${this.orderId}`),
so the instance is the only thing that can answer which channel this page's
order broadcasts on. The Laravel adapter also accepts a class name and builds
it without calling its constructor; in JavaScript the equivalent
(`Object.create(OrderUpdated.prototype)`) yields `private-orders.undefined`
without any error, which is worse than refusing. A class is therefore not
accepted in this RFC (see Open Question 1); an event whose channel does not
depend on its payload is still a one-line `new ActivityLogged()`.

Two functions in a new `packages/server/src/broadcasting/event-target.ts` are
the one reading of a broadcastable event:

```ts
/** The name an event is broadcast as: `broadcastAs()`, else its pinned `eventName`, else its class name. */
export function broadcastNameOf(event: LiveEvent): string

/** The channels it is broadcast on, as wire names, `broadcastOn()` verbatim. */
export function broadcastChannelsOf(event: LiveEvent): string[]
```

`live()` calls them, and so does a new sender on `BroadcastManager`:

```ts
/** Publishes `event.broadcastWith?.() ?? {}` as `broadcastNameOf(event)` on every channel `broadcastChannelsOf(event)` names. */
async broadcastEvent(event: BroadcastableEvent, options?: { except?: Request | string | null }): Promise<void>
```

Today the docs tell an app to write that loop itself
(`docs/en/guides/broadcasting.md`, "Broadcasting from Events"), with
`event.broadcastAs?.() ?? event.eventName` spelled inline. A live prop subscribes
to the name `live()` computed, and an app that spells the sending side
differently gets a prop that never refreshes and no error anywhere. With one
function on both sides, `broadcastEvent()` and the docs' loop become the same
code, and the guide is rewritten around `broadcastEvent()`.

The class-name fallback has the bundling hazard `.claude/rules/common-pitfalls.md`
records for every name-keyed class (`OrderShipped2` when two modules declare
the name). The docs for live props tell an app to pin `static eventName`, or
define `broadcastAs()`, on any event a live prop listens for; `guren check`
warns on one that does neither (§7).

#### Channel names

Guren channel names carry their type as a prefix, and Inertia's carry it
separately. `live()` maps one to the other, and the client transport maps it
back:

| Guren wire name     | `LiveChannel`                              |
|---------------------|--------------------------------------------|
| `announcements`     | `{ name: 'announcements', type: 'public' }` |
| `private-orders.1`  | `{ name: 'orders.1', type: 'private' }`     |
| `presence-chat.2`   | `{ name: 'chat.2', type: 'presence' }`      |

The prefixes are `PrivateChannel.PREFIX` and `PresenceChannel.PREFIX`, read
from those classes rather than restated. Listeners are grouped per
`type:name` with their events deduplicated, the shape the Laravel adapter's
`addLiveListener()` produces.

#### Composing with `defer()`, `always()` and lazy values

`live()` wraps any other prop input, and nothing wraps `live()`:

| Input                                   | Initial visit                      | Partial reload selecting the key | `liveProps` entry           |
|-----------------------------------------|------------------------------------|----------------------------------|-----------------------------|
| `live(value, …)`                        | sent                               | sent                             | every response carrying it  |
| `live(() => …, …)`                      | resolved and sent                  | resolved and sent                | every response carrying it  |
| `live(defer(() => …), …)`               | announced in `deferredProps`       | resolved and sent                | initial visit, and reloads  |
| `live(always(…), …)`                    | sent                               | sent on every partial reload     | every response              |
| `live(always(defer(…)), …)`             | announced                          | sent on every partial reload     | every response              |

`always(live(…))` throws when it is called~~, and `always()`'s parameter type
excludes `LiveProp`~~. `defer()` takes a callback, so the form to refuse there is
`defer(() => live(…))`~~: its callback's return type excludes `LiveProp`, and~~**;**
since the value only exists once the deferred request runs it, the resolver
throws when a deferred callback, or a lazy function, returns a `LiveProp`.
**Amended in implementation:** the helpers' parameter types are unchanged.
Excluding `LiveProp` there (an intersection with `{ [LIVE_BRAND]?: never }`)
rejected `always()` of a `string | undefined`, `unknown` or `null` value and
every generic pass-through, which the frontend guide's own `always(getFlash(…))`
is. The type-level refusal is `InertiaPropInput`'s: `always(live(…))` is no
input `this.inertia()` accepts for any prop. One
spelling per combination is what lets `guren check` read them (§7). This mirrors `always(defer(…))`, where the
modifier also wraps the value. The Laravel adapter's
`Inertia::defer(…)->live(…)` chain is not copied, because Guren's prop helpers
are frozen brand objects rather than builders (Alternatives).

Guren has no merge, once or optional props. If one is added later, it refuses
to compose with `live()`, as the Laravel adapter's `merge()` does, because a
refresh would append rather than replace.

#### The page object

`InertiaPagePayload` (`InertiaEngine.ts`) and `ResolvedInertiaPage` (`props.ts`)
gain `liveProps?: Record<string, LivePropEntry>` in Inertia's shape, present only
when non-empty, the way `deferredProps` is. `resolveInertiaProps()` decides it
with the adapter's rule:

- **A full visit** lists every live key, a deferred one included, since the
  client must hold the listener before the deferred request returns.
- **A partial reload** lists a live key only when it resolves that key: the key
  is selected by `only`/`except`, or wrapped in `always()`. The client keeps the
  entries it already has for every other key.
- **A key that stops being live.** The client merges `liveProps` shallowly over
  what it holds (`response.ts` in `@inertiajs/core`), so leaving a key out never
  removes its listeners. ~~A partial reload that resolves a key as a plain prop
  (a controller that makes `order` live only while the order is open) lists it
  as `{ listeners: [] }`, on which the client drops its subscriptions. The
  Laravel adapter does not do this; the entry costs a few bytes per selected
  key and is never sent on a full visit, where the client replaces the whole
  map.~~ **Amended in implementation:** no empty entry is sent, as in the
  Laravel adapter. After a reconnect Inertia reloads every key it holds an
  entry for, an empty one included, and a partial reload cannot tell a key that
  stopped being live from one that never was: the client's own deferred-group
  fetch would have left an empty entry for every plain deferred key, each then
  reloaded on every reconnect. A key that stops being live keeps its listeners
  until the next full visit, and each of its events costs one reload that
  returns the plain value.

`@guren/testing`'s controller mock builds its page through
`buildInertiaPage()`, so the payload carries `liveProps` with no change there,
and a test can assert on `page.liveProps.order.listeners`. The mock's module
object lists its exports one by one (`packages/testing/src/controller.ts`), so
~~`live` and `isLiveProp` are added to it~~ **(amended in implementation:
`always`, `defer` and `live` are added, since `always` and `defer` were missing
too, and nothing in a controller calls `isLiveProp`)**, or a controller importing `live` from
the mocked `@guren/core` fails to load. The prototype client
(`@guren/inertia-client/prototype`, RFC 0021) answers fixtures without a
server and never sees a live prop; its own partial-reload filter does not
change.

### 2. A `channel` on every WebSocket frame

A frame on `/broadcasting/socket` is `{ event, data }`, and an SSE message is
`event:` plus `data:`. Neither names the channel the event arrived on. Inertia
routes an event by channel *and* name, and two pages' live props routinely
share a name across channels (`OrderUpdated` on `private-orders.1` and on
`private-orders.2`), so a single connection cannot route without the channel.
`createUseChannel()` dodges this by opening one stream per channel, which is
the connection-limit problem above.

The frame gains the channel the driver delivered the event on:

```json
{ "event": "OrderUpdated", "channel": "private-orders.1", "data": { "status": "shipped" } }
```

`WebSocketClient.send(event, data)` becomes `send(event, data, channel?)`.
`subscribeWebSocketClient()` passes the channel (and so does `subscribeClient()`
for `SSEClient.send`, whose SSE route ignores it); `webSocketMiddleware()`'s
`send` writes it when present. Control frames (`connected`, `subscription`)
carry none. A JSON consumer that ignores unknown keys sees no change, and a
custom socket route registered through `registerWebSocketClient()` may ignore
the third argument, so the change is additive for both. SSE is left alone in
this RFC: its `data:` is the payload itself, so adding the channel there changes
what every existing `useChannel()` handler parses (Open Question 3).

### 3. The client transport

A new entry point, `@guren/inertia-client/live`:

```ts
import type { LiveOptions as InertiaLiveOptions } from '@inertiajs/core'

export interface GurenLiveOptions {
  /** The `webSocketMiddleware()` route. Default `/broadcasting/socket`, resolved against `location`. */
  url?: string
  /** Passed through to Inertia. */
  throttle?: number
  pauseWhenHidden?: boolean
  /** For tests and non-browser runtimes. Default `(url) => new WebSocket(url)`. */
  webSocketFactory?: (url: string) => WebSocket
}

export function liveTransport(options?: GurenLiveOptions): InertiaLiveOptions
```

and `startInertiaClient()` forwards a new `live` option to
`createInertiaApp()`:

```ts
// resources/js/app.tsx
import { startInertiaClient } from '@guren/inertia-client/app'
import { liveTransport } from '@guren/inertia-client/live'

startInertiaClient({ pages, live: liveTransport() })
```

`StartInertiaClientOptions.live` is typed `LiveOption` from `@inertiajs/core`,
so an app may pass any transport Inertia accepts, its own included. The SSR
entry (`@guren/inertia-client/server`) takes no `live`, matching
`@inertiajs/react`'s `live?: never` on the server options, and the prototype
entry does not forward it, since a static prototype build has no socket to
open.

What the transport does, as a `LiveTransport` (it routes by event name):

- **One socket per tab, opened on the first `subscribe()`.** A page with no
  live props opens nothing. The socket is closed a few seconds after the last
  channel is released, so navigating between two live pages keeps it.
- **Channels reference-counted by wire name.** `subscribe(channel, event, handler)`
  maps `{ name, type }` back to the wire name (the table in §1), and sends
  `{ action: 'subscribe', channel }` only for the first listener of that name;
  the returned function sends `unsubscribe` after the last. Inertia's own
  channel tracker is not exported from `@inertiajs/core`, so the transport keeps
  its own count. Subscriptions requested before the socket is open are queued
  and sent after `connected`.
- **Paced subscriptions.** The server closes a socket with 1008 once 32
  messages wait for an answer, and an authorizer may be slow, so the transport
  keeps at most 16 `subscribe`/`unsubscribe` messages outstanding and sends the
  next one as each `subscription` answer arrives.
- **Routing** by the frame's `channel` and `event` to the handlers registered
  for that pair. A frame without a channel (an older server) is dropped, never
  guessed, and the transport warns once naming the minimum `@guren/server`.
- **No values from the wire.** Before a payload reaches Inertia's handler the
  transport removes its `__inertia` key. Inertia writes `__inertia.props`
  straight into the page with no option to refuse it, and `broadcast()` forwards
  whatever data an app hands it, so an app that relays user-supplied data on a
  channel would otherwise let that data overwrite another user's props. While
  this RFC adopts no value mode, every event only ever triggers a reload.
- **A refused channel** (`subscription` with `authorized: false`) is warned
  about once, naming the channel, and its handlers stay registered without
  traffic, the same outcome Inertia's own transports give: the prop stays at
  the value the page rendered.
- **Status.** The transport reports `false` through `onStatusChange` when the
  socket closes; Inertia refreshes only on a `true` that follows a `false`.
- **Reconnects** with backoff (1 s doubling to 30 s). A reconnected socket is a
  new `clientId` with no subscriptions on the server, so the transport sends
  `subscribe` for every channel it holds and reports `true` only after every one
  of them is answered. Reporting earlier would let Inertia's catch-up reload
  read the state before a subscription is active, and an event published in
  between would be lost. With the Redis driver the answer still precedes the
  Redis subscription itself (`RedisDriver.subscribe()` does not wait for it),
  which Open Question 6 takes up. After five consecutive attempts that end
  without a `connected` frame (a runtime that answers 501, §5, or a socket
  closed with 1008), it stops, warns once, and the page keeps working with
  static props.
- **`socketId()`** returns the socket id from the `connected` frame (§4), or
  `null` before it arrives.

The transport is a module of its own rather than part of `./app` so an app
without live props never bundles it. It has no dependency beyond
`@inertiajs/core`, which `@guren/inertia-client` already depends on.

### 4. Socket ids and `toOthers`

A user who saves an order receives the redirect with the new value, and then
the broadcast of the same change, which reloads the prop a second time. Inertia
handles this by sending the transport's socket id as `X-Socket-Id` and dropping
an event whose envelope carries the same id.

`clientId` is not used as that id. Today it reaches only its own connection,
in the `connected` frame, but as a socket id it would sit in the envelope of
every excluded event, in front of every subscriber of the channel, and
`POST /broadcasting/auth` attaches channels to a `clientId` it is given when the
stream is unowned (opened before sign-in, or by a user object with no `id`,
`sub` or `userId`). The `connected` frame gains a second, unrelated value:

```json
{ "event": "connected", "data": { "clientId": "ws_…", "socketId": "s_…", "channels": [] } }
```

`socketId` is 16 random bytes from the same `randomHex()` the client id uses,
held on the `WebSocketClient` record and accepted nowhere as an input. SSE
clients get none, since the transport does not use them.

`broadcastEvent(event, { except })` takes ~~the request (or the header value)~~
**the request's context (`this.ctx` in a controller), or `{ socketId, user }`
given by hand (amended in implementation: a `Request` or a bare header value
carries no signed-in user to bind the match to)**,
reads `X-Socket-Id`, and publishes the payload as
`{ ...payload, __inertia: { socketId, userId } }`, where `userId` is the
requester's id read the way `resolveClientUserId()` reads a socket's owner.
Exclusion happens on the server, in the one delivery callback
`openDriverSubscription()` wraps for both transports:

- A WebSocket client is skipped only when its `socketId` matches **and** its
  owner is the same `userId`. A socket with no owner, or a request with no
  user, is never skipped.
- Every client, WebSocket or SSE, receives the payload with the `__inertia` key
  the manager added removed. Neither the socket id nor the user id leaves the
  server, and no driver changes: they ride inside `data`, which `MemoryDriver`
  and `RedisDriver` already carry opaquely across instances.

The header is client-supplied, and binding the match to the requester's user is
what makes a guessed or leaked value harmless: a user can only suppress
deliveries to their own sockets, which they could do by not subscribing. A
custom route registered through `registerWebSocketClient()` goes through the
same callback, so it strips the key as well. Inertia's own browser-side check
(dropping an event whose envelope matches) then never fires for Guren's
transports, and does no harm for others.

### 5. Authorization and runtimes without broadcasting

**Authorization does not change.** A transport subscription is a `subscribe`
message on the socket, authorized by the channel's registered authorizer
against the user of the upgrade request, exactly as today. The `liveProps`
entries name channels in the page JSON; they confer nothing, because every
subscription still goes through `authorize()`, and an unregistered
`private-`/`presence-` name is denied by default. Since the transport strips
`__inertia` (§3), an event can only make the client reload a prop, and the
reload is an ordinary request through the controller's middleware and
policies, so the *prop* never holds more than the user may see.

The socket is another matter, and live props inherit its existing limits
rather than fixing them:

- A socket keeps the user it opened with for its lifetime. Every later
  `subscribe` is authorized against that user, and delivery never asks again,
  so a user who signs out or loses access keeps receiving the raw payload of
  every event on the channels they hold until the app removes their clients
  (the guide's existing note). Live props add events to those channels, not new
  channels, but the payload is what leaks. The live props guide therefore tells
  apps to keep the payload of an event a live prop listens for to identifiers
  (`broadcastWith()` returning `{ orderId }`), since the prop's value arrives by
  reload anyway.
- An unowned stream accepts channels from anyone holding its `clientId`. This
  RFC does not widen who learns a `clientId` (§4).

Closing a user's sockets at sign-out, and claiming an unowned stream for the
first user who attaches to it, are fixes to broadcasting itself; Open
Question 7 asks whether they belong in this RFC's milestone 2 or a separate one.

**Presence channels** subscribe the same way. A live prop listens for events on
them and joins no member list; joining stays the app's call.

**Runtimes without broadcasting.** `live()` reads its event and writes
metadata, and needs no `BroadcastManager` at render time, so a controller
using it renders on every runtime. What differs is the client:

- With no transport passed to `startInertiaClient()`, Inertia never subscribes
  and a live prop is an ordinary prop. This is how an app opts out, per build,
  without touching a controller.
- On Workers, Lambda, Vercel or Node, `webSocketMiddleware()` answers 501 (it
  needs `Application.listen()` on Bun). The transport's capped retries (§3)
  stop and warn once, and the page keeps its static props. Events published
  from a function through the Redis driver still reach a socket served by a
  Bun process elsewhere; `liveTransport({ url })` points at that origin.
- `guren check` warns, advisory, when a controller uses `live()` and no route
  mounts `webSocketMiddleware()` (§7).

A Durable Objects or other hosted transport for Workers is a separate RFC; the
seam is Inertia's, so it needs nothing from this one.

### 6. Types and codegen

```ts
/** What a prop accepts today, every `always()` composition the resolver runs included. */
type PlainPropInput<T> = T | DeferredProp<T> | (() => T | Promise<T>)
type BasePropInput<T> = PlainPropInput<T> | AlwaysProp<PlainPropInput<T>>

export type InertiaPropInput<T> = BasePropInput<T> | LiveProp<BasePropInput<T>>

export type ResolvedInertiaProp<V> = V extends LiveProp<infer Inner>
  ? ResolvedInertiaProp<Inner>
  : V extends AlwaysProp<infer Inner>
    ? ResolvedInertiaProp<Inner>
    : V extends DeferredProp<unknown>
      ? Awaited<ReturnType<V['resolve']>>
      : V extends () => infer R
        ? Awaited<R>
        : V
```

The `AlwaysProp` branch recurses, where today it stops at `V['value']`: the
resolver unwraps `always()` and then runs a deferred or lazy value, so
`always(defer(() => 1))` and `always(() => 1)` resolve to `number` at runtime
while their type stays the wrapper. `AlwaysProp<PlainPropInput<T>>` widens the
input the same way, so `always(defer(…))`, which `guren check` already reads,
also typechecks.

`PagePropsMap` and the page's `Props` do not change: a live prop arrives as
the value it resolves to, and the page cannot tell it apart, which is the
point. `.guren/channels.gen.ts` (`packages/cli/src/channel-types.ts`) learns
`broadcastEvent(new X(…))`, reading the channels and payload type from the
class's `broadcastOn()` and `broadcastWith()` where the reader can, so
`ChannelEvents` keeps listing events an app now sends through the new call.
`useProp()` from `@inertiajs/react` works as shipped; a `PagePropsMap`-typed
wrapper is Open Question 4.

### 7. `guren check`

- **Deferred props** (`packages/cli/src/deferred-props-check.ts`). `isDeferCall()`
  learns to see through `live()`: `live(defer(…))` and `live(always(defer(…)))`
  hand the component `undefined` on the initial visit exactly as `defer(…)`
  does, and `InertiaPropInput` admits them for a required prop for the same
  reason. The rule, its advisory severity and its unverifiable cases are
  otherwise unchanged; `live` joins `defer` and `always` in
  `propHelperBindings()`, and a `live` import also activates the check.
- **Live props** (new, `packages/cli/src/live-props-check.ts`, advisory,
  content-activated on a controller importing `live` from `@guren/core`):
  - no routes file mounts `webSocketMiddleware()` (from the introspected
    routes when `guren check` introspects, else the routes source), so no
    transport could ever connect;
  - an event class passed to `live()` that neither defines `broadcastAs()` nor
    pins a static `eventName`, since its wire name is its class name (§1);
  - `always(live(…))`, or `defer(() => live(…))` whose callback returns the
    call literally (both also runtime errors).

  A spread or a non-literal options argument is reported unverifiable, never
  passed. Matching a channel against the registered authorizers is left out:
  channel names are template literals over the event's fields, and the reader
  would have to guess (Open Question 2).

### Values carried by the event

Inertia lets an event carry the new value (`__inertia.props`) so no reload is
made. This RFC leaves it out. A carried value skips the per-request resolution
that a reload runs, so every subscriber of the channel receives the same value,
and a prop that depends on who is looking (a policy-filtered list, a
translated string, `canEdit`) leaks or goes wrong. It also needs a server
helper that resolves values the way `resolveInertiaProps()` does without a
request. Until then the transport removes the key from every payload (§3), so
no value written by a sender can reach a page. A later RFC can add one once an
app has measured that reloads are the
cost worth removing.

### Milestones

1. **Server props.** `live()`, `isLiveProp()`, `liveProps` in
   `resolveInertiaProps()` and `InertiaPagePayload`, `broadcastNameOf()` /
   `broadcastChannelsOf()`, `BroadcastManager.broadcastEvent()`, the types, and
   the broadcasting guide's "Broadcasting from Events" section rewritten around
   `broadcastEvent()`, and `live`/`isLiveProp` in `@guren/testing`'s module
   mock.
2. **Socket protocol.** `channel` on WebSocket frames, `socketId` on
   `connected`, user-bound exclusion and `__inertia` stripping in the delivery
   callback both transports share, `broadcastEvent({ except })`.
3. **Client.** `@guren/inertia-client/live` and `startInertiaClient({ live })`,
   with a browser test against the blog example (an order page in two
   contexts, one saving, one refreshing).
4. **Checks and codegen.** The deferred-props change, the live-props check,
   `channels.gen.ts` reading `broadcastEvent()`, and the docs page
   (`docs/en/guides/live-props.md` and its `docs/ja` counterpart).

## Alternatives Considered

**`defer(…).live(…)` chaining, as in the Laravel adapter.** `always()` and
`defer()` return frozen brand objects, and `resolveInertiaProps()` identifies
them by symbol. Giving every brand a `live()` method makes each helper a
builder, means `always(x).live()` and `live(always(x))` both have to work or
one of them silently does not, and doubles what `guren check` must read. The
wrapping form already exists (`always(defer(…))`) and stays one spelling.

**One `EventSource` per channel, reusing `createUseChannel()`.** No server
change, since SSE already authorizes `?channels=` up front. Rejected for the
HTTP/1.1 limit of six connections per origin, which a page with a few live
props reaches before it makes its own requests, and because every channel
change reopens a stream rather than sending a message.

**Multiplex SSE instead of WebSocket.** SSE works behind proxies that drop
upgrades and runs on Node, which the WebSocket route does not. Adding the
channel to SSE changes the `data:` every existing `useChannel()` handler parses,
so it needs an opt-in flag on the stream; Open Question 3 keeps it open for a
second transport.

**Ship the Laravel Echo or Pusher transport and require a Pusher-protocol
server (Reverb, Soketi).** Inertia already ships both. Guren's broadcasting
speaks its own protocol, authorizes through its own authorizers, and an app
would have to run and secure a second server to use a feature its own
`webSocketMiddleware()` can carry.

**Accept an event class as `on`, built without its constructor.** Laravel does
this with `newInstanceWithoutConstructor()`. In JavaScript the instance's
fields are `undefined`, so `broadcastOn()` returns `private-orders.undefined`,
a channel that exists for nobody and fails silently. Open Question 1 keeps a
safer class form open.

**Exclude the sender inside the driver.** `publish(channel, event, data, { except })`
would keep the id out of `data`, but `BroadcastDriver` is implemented by apps
and plugins, and a new parameter they ignore turns exclusion off without an
error. Carrying it in `data`, where every driver already passes it through,
keeps exclusion working with any driver.

**Use `clientId` as the socket id.** One value fewer, but `clientId` is an input
to `POST /broadcasting/auth`, and the envelope would put it in front of every
subscriber (§4).

## Migration Path

Additive. No existing call changes meaning:

- `live()`, `broadcastEvent()`, `broadcastNameOf()`, `broadcastChannelsOf()`
  and `@guren/inertia-client/live` are new names. `InertiaPropInput` widens.
- `WebSocketClient.send` and `SSEClient.send` gain an optional parameter; a custom route's
  implementation that ignores it keeps working, and so does a client that
  ignores the frame's `channel` key.
- `connected` gains `socketId`; a client reading `clientId` and `channels`
  sees the same values.

**Prerequisite:** `@inertiajs/core` and `@inertiajs/react` at `^3.11.0` in
`@guren/inertia-client` and the templates, which is in progress separately
(branch `fix/inertia-3-11-query`) and is not part of this RFC's
implementation. Milestone 3 cannot start before it lands; milestones 1 and 2
can, since they touch only the server.

`@guren/inertia-client/live` requires a server with milestone 2. Against an
older server the transport sees frames without `channel`, drops them, and
warns with the version, rather than routing an event to the wrong prop. Both
packages move in the same release, so `guren upgrade` and a fresh scaffold
never pair them wrongly.

The starter templates do not change: broadcasting is not part of the starter,
and an app adds `live: liveTransport()` when it mounts the socket route.
Whether `make:feature` or a future `guren add broadcasting` should do that is
left to that command.

## Open Questions

1. **A class as `on`.** Is there a safe class form? One candidate: accept a
   class only when it declares `static broadcastOn(): string[]` (a fixed
   channel), and refuse any other class with a message pointing at
   `new X(…)`. This adds a second, static spelling of `broadcastOn` for the
   sake of a shorter call site.
2. **Checking channels against authorizers.** `guren check` could match
   `broadcastOn()`'s template literal (`private-orders.${…}`) against the
   `privateChannel()` patterns registered in providers, and warn on a
   `private-` channel no pattern matches, the case where the default deny
   leaves a prop stale with only a console warning. Worth a static reader with
   an unverifiable result, or left to the transport's warning?
3. **An SSE transport.** For apps on Node or behind proxies that drop upgrades:
   an opt-in stream flag (`?frames=1`) under which each message's `data` is
   `{ channel, data }`, and a `liveTransport({ via: 'sse' })` that uses it,
   subscribing private channels through `POST /broadcasting/auth` with the
   stream's `clientId`. Is that worth a second protocol to maintain?
4. **A typed `useProp`.** Re-export `useProp` from `@guren/inertia-client` keyed
   by the current page's `PagePropsMap` entry, so `useProp('order')` is
   checked against the page's `Props`, or leave Inertia's `string`-keyed hook
   as is?
5. **Socket idle timeout.** How long the transport keeps a socket open after
   the last channel is released. A few seconds covers navigation between two
   live pages; a longer value saves reconnects at the cost of an idle
   connection per tab.
6. **Subscription readiness with Redis.** The `subscription` answer is sent
   once the manager has registered the callback, while `RedisDriver.subscribe()`
   sends `SUBSCRIBE` without waiting for Redis to confirm it. An event published
   in that gap is lost to the reconnect's catch-up reload. Should the driver
   interface gain an optional readiness promise the answer waits for, or is the
   gap small enough to document?
7. **Socket lifetime fixes.** Closing a user's sockets at sign-out (an auth
   event the broadcast manager listens for) and claiming an unowned stream for
   the first user who attaches to it close the two limits §5 names. They change
   broadcasting for every app, live props or not. Part of milestone 2, or an
   RFC of their own?
