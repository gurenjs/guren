/**
 * Model lifecycle hook names. A "before" hook (`creating`, `updating`,
 * `deleting`, `saving`) aborts the operation by returning `false`.
 * `saving`/`saved` fire for both create and update.
 */
export type HookName =
  | 'creating'
  | 'created'
  | 'updating'
  | 'updated'
  | 'deleting'
  | 'deleted'
  | 'saving'
  | 'saved'

/** Callback for a model lifecycle hook; `false` from a before-hook aborts. */
export type HookCallback<T = Record<string, unknown>> = (data: T) => void | Promise<void> | false | Promise<false>

export type ModelHooks = {
  [K in HookName]?: HookCallback
}

/** Runs the hook if present; `false` means the operation should be aborted. */
export async function executeHook(
  hooks: ModelHooks | undefined,
  name: HookName,
  data: Record<string, unknown>,
): Promise<boolean> {
  if (!hooks || typeof hooks[name] !== 'function') {
    return true
  }

  const result = await hooks[name]!(data)
  return result !== false
}
