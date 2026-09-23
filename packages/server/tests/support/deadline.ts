/**
 * Reject if `promise` has not settled within `ms`, so a promise that never
 * settles fails the test instead of hanging the runner.
 */
export function settleWithin<T>(promise: Promise<T>, ms: number, reason?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(reason ?? `promise did not settle within ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
