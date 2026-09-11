/**
 * The capability `T` a model class implements, or null. A capability check
 * rather than `instanceof`: two copies of @guren/server coexist through
 * workspace symlinks (src and dist), and a nominal test answers "no" for the
 * copy it was not built from, silently ignoring a renamed credential column or
 * a hasher the app bound.
 */
export function capabilityOf<T>(model: unknown, ...methods: Array<keyof T & string>): T | null {
  const candidate = model as Record<string, unknown> | null | undefined
  if (!candidate) return null
  return methods.every((method) => typeof candidate[method] === 'function') ? (candidate as T) : null
}
