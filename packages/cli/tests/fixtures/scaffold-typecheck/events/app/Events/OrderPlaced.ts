// Companion for typechecking templates/scaffold/events: what
// makeEvent('OrderPlaced') emits. Pinned to the builder by
// scaffold-output.test.ts, so a builder change fails there with
// instructions rather than silently drifting from this copy.
import { Event } from '@guren/core'

export class OrderPlaced extends Event {
  static override eventName = 'OrderPlaced'

  constructor(
    public readonly data: Record<string, unknown> = {},
  ) {
    super()
  }
}
