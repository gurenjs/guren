import { ServiceProvider, type EventManager } from '@guren/core'
import { SendOrderReceiptListener } from '../Listeners/SendOrderReceiptListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')

    events.listen(SendOrderReceiptListener)
  }
}
