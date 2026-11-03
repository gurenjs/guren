---
'@guren/server': minor
'@guren/testing': patch
'@guren/cli': patch
---

Add `live()`, the server half of Inertia's live props (RFC 0037). `live(value, { on: new OrderUpdated(order.id) })` wraps any other prop input (`live(defer(…))`, `live(always(…))`) and the page object gains `liveProps`, the channel and event listeners Inertia 3.11 subscribes to: every live prop on a full visit, deferred ones included, and the props a partial reload resolves. A page with no live prop sends the payload it sent before. `live()` must be the outermost helper: `always(live(…))` and a deferred or lazy value that resolves to a live prop throw, and `this.inertia()` refuses them as prop inputs.

`BroadcastManager.broadcastEvent(event)` sends a `BroadcastableEvent` on every channel `broadcastOn()` names, as `broadcastAs()`, else its `eventName`. `broadcastNameOf()` and `broadcastChannelsOf()` are that reading, which `live()` uses too, so a live prop listens for the name the event is sent under.

`ResolvedInertiaProp` now resolves through `always()`, so `always(defer(() => 1))` and `always(() => 1)` are typed as `number`, and `InertiaPropInput` accepts them.

`@guren/testing`'s controller module mock now exports `always`, `defer` and `live`, so a controller using them loads under the mock. `guren check`'s deferred-props warning sees a `defer()` inside `live()`.

The client transport is not part of this release.
