export function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then: unknown }).then === 'function'
}
