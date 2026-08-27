import { ServiceProvider, type EventManager } from '@guren/core'
import { OrderPlaced } from '../Events/OrderPlaced.js'
import { SendOrderReceiptListener } from '../Listeners/SendOrderReceiptListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')
    const listener = new SendOrderReceiptListener()

    events.on(OrderPlaced, (event) => listener.handle(event), {
      priority: SendOrderReceiptListener.priority,
    })
  }
}
