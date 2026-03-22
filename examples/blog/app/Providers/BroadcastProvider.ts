import {
  ServiceProvider,
  createBroadcastManager,
  MemoryBroadcastDriver,
  type BroadcastManager,
} from '@guren/core'

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
    broadcast.channel('announcements', () => true)
    broadcast.privateChannel('posts.{id}', () => true)
  }
}
