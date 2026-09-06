/**
 * Whether the fixture agents' `onToolApprovalSettled` throws.
 *
 * The hook is application code running inside a schedule the SDK would replay,
 * so "a throwing hook does not strand the other rows" is a real invariant. Its
 * own module for the reason `routing-switch.ts` is one: the suite moves it over
 * HTTP rather than by importing the worker.
 */
let throwing = false

export function setHookThrows(value: boolean): void {
  throwing = value
}

export function hookThrows(): boolean {
  return throwing
}
