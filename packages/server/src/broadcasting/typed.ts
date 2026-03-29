import type { BroadcastManager } from './BroadcastManager'
import type { Channel, PresenceChannel, PrivateChannel } from './channels'

type ChannelEventsMap = Record<string, Record<string, unknown>>
type ChannelNameFor<TEvents extends ChannelEventsMap> = keyof TEvents & string
type EventNameFor<TEvents extends ChannelEventsMap, TChannel extends ChannelNameFor<TEvents>> =
  keyof TEvents[TChannel] & string
type PayloadFor<
  TEvents extends ChannelEventsMap,
  TChannel extends ChannelNameFor<TEvents>,
  TEvent extends EventNameFor<TEvents, TChannel>,
> = TEvents[TChannel][TEvent]

export interface TypedChannelHandle<
  TEvents extends ChannelEventsMap,
  TChannel extends ChannelNameFor<TEvents>,
> {
  readonly name: TChannel
  broadcast<TEvent extends EventNameFor<TEvents, TChannel>>(
    event: TEvent,
    payload: PayloadFor<TEvents, TChannel, TEvent>,
  ): Promise<void>
}

export interface TypedPrivateChannelHandle<
  TEvents extends ChannelEventsMap,
  TChannel extends ChannelNameFor<TEvents>,
> extends TypedChannelHandle<TEvents, TChannel> {
  readonly name: TChannel
}

export interface TypedPresenceChannelHandle<
  TEvents extends ChannelEventsMap,
  TChannel extends ChannelNameFor<TEvents>,
> extends TypedChannelHandle<TEvents, TChannel> {
  readonly name: TChannel
}

export interface TypedBroadcaster<TEvents extends ChannelEventsMap> {
  broadcast<TChannel extends ChannelNameFor<TEvents>, TEvent extends EventNameFor<TEvents, TChannel>>(
    channel: TChannel,
    event: TEvent,
    payload: PayloadFor<TEvents, TChannel, TEvent>,
  ): Promise<void>

  toChannel<TChannel extends ChannelNameFor<TEvents>>(channel: TChannel): TypedChannelHandle<TEvents, TChannel>
  toPrivate<TChannel extends ChannelNameFor<TEvents>>(channel: TChannel): TypedPrivateChannelHandle<TEvents, TChannel>
  toPresence<TChannel extends ChannelNameFor<TEvents>>(channel: TChannel): TypedPresenceChannelHandle<TEvents, TChannel>
}

export function createTypedBroadcaster<TEvents extends ChannelEventsMap>(
  manager: BroadcastManager,
): TypedBroadcaster<TEvents> {
  return {
    broadcast(channel, event, payload) {
      return manager.broadcast(channel, event, payload)
    },
    toChannel(channel) {
      return wrapChannel<TEvents, typeof channel>(channel, manager.toChannel(channel))
    },
    toPrivate(channel) {
      return wrapChannel<TEvents, typeof channel>(channel, manager.toPrivate(channel))
    },
    toPresence(channel) {
      return wrapChannel<TEvents, typeof channel>(channel, manager.toPresence(channel))
    },
  }
}

function wrapChannel<TEvents extends ChannelEventsMap, TChannel extends ChannelNameFor<TEvents>>(
  name: TChannel,
  channel: Channel | PrivateChannel | PresenceChannel,
): TypedChannelHandle<TEvents, TChannel> {
  return {
    name,
    broadcast(event, payload) {
      return channel.broadcast(event, payload)
    },
  }
}
