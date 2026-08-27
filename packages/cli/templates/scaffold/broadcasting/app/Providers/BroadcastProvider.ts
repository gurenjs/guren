import { ServiceProvider, createBroadcastManager, MemoryBroadcastDriver, type BroadcastManager } from '@guren/core'
import OrdersChannel from '../Broadcasting/OrdersChannel.js'
import UserFeedChannel from '../Broadcasting/UserFeedChannel.js'

export default class BroadcastProvider extends ServiceProvider {
  register(): void {
    this.container.instance('broadcast', createBroadcastManager({
      default: 'memory',
      drivers: {
        memory: () => new MemoryBroadcastDriver(),
      },
    }))
  }

  boot(): void {
    const broadcast = this.container.make<BroadcastManager>('broadcast')
    const orders = new OrdersChannel(broadcast)
    const userFeed = new UserFeedChannel(broadcast)

    // A public channel is open by definition. A private one is not: register
    // the channel's own authorize() so the check in UserFeedChannel is the
    // check that runs.
    broadcast.channel(orders.getChannelName(), () => true)
    broadcast.privateChannel(userFeed.getBaseName(), (channelName, user) => userFeed.authorize(channelName, user))
  }
}
