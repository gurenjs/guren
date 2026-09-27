/** Successful steps stay complete; a rejected step must be safe for its owner to retry. */
export class BootSequence {
  private next = 0
  private pending?: Promise<void>

  constructor(private readonly steps: ReadonlyArray<() => void | Promise<void>>) {}

  run(): Promise<void> {
    // Publish the promise before invoking user code, including synchronous hooks.
    this.pending ??= Promise.resolve().then(async () => {
      try {
        while (this.next < this.steps.length) {
          await this.steps[this.next]!()
          this.next++
        }
      } catch (error) {
        this.pending = undefined
        throw error
      }
    })
    return this.pending
  }
}
