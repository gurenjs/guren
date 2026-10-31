/** One signal for "the reviewer changed something", which the Dev Center's autosave listens to. */

const listeners: Array<() => void> = []

export function onReviewChange(listener: () => void): void {
  listeners.push(listener)
}

export function reviewChanged(): void {
  for (const listener of listeners) listener()
}
