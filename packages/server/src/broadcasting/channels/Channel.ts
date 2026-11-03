import { stripSender } from '../sender-envelope'
import type { BroadcastDriver } from '../types'

export class Channel {
  constructor(
    public readonly name: string,
    protected driver: BroadcastDriver
  ) {}

  async broadcast(event: string, data: unknown): Promise<void> {
    await this.driver.publish(this.name, event, stripSender(data))
  }

  /** Returns an unsubscribe function. */
  subscribe(
    callback: (event: string, data: unknown) => void
  ): () => void {
    return this.driver.subscribe(this.name, (e) => {
      callback(e.event, stripSender(e.data))
    })
  }

  getChannelName(): string {
    return this.name
  }
}
