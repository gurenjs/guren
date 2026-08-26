// Companion for typechecking templates/scaffold/events: what
// makeListener('SendOrderReceipt', { event: 'OrderPlaced' }) emits. Pinned
// to the builder by scaffold-output.test.ts, so a builder change fails
// there with instructions rather than silently drifting from this copy.
import { Listener } from '@guren/core'
import { OrderPlaced } from '../Events/OrderPlaced'

export class SendOrderReceiptListener extends Listener<OrderPlaced> {
  static override event = OrderPlaced

  async handle(event: OrderPlaced): Promise<void> {
    void event
  }

  static override shouldQueue = false

  async failed(event: OrderPlaced, error: Error): Promise<void> {
    console.error('SendOrderReceiptListener failed:', error.message)
  }
}
