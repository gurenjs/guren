// Companion for typechecking templates/scaffold/broadcasting: what
// makeChannel('Orders', { channel: 'orders' }) emits. Pinned to the
// builder by scaffold-output.test.ts, so a builder change fails there
// with instructions rather than silently drifting from this copy.
import { Channel, type BroadcastManager } from '@guren/core'

export default class OrdersChannel extends Channel {
  constructor(manager: BroadcastManager) {
    super('orders', manager.driver())
  }
}
