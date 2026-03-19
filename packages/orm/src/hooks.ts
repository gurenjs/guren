/**
 * Model lifecycle hook names.
 *
 * "Before" hooks (`creating`, `updating`, `deleting`, `saving`) fire before
 * the database operation. If they return `false`, the operation is aborted.
 *
 * "After" hooks (`created`, `updated`, `deleted`, `saved`) fire after the
 * database operation completes.
 *
 * `saving`/`saved` fire for both create and update operations.
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

/**
 * Callback signature for model lifecycle hooks.
 *
 * @param data - The record data being operated on
 * @returns void for after-hooks. Returning `false` from a before-hook aborts the operation.
 */
export type HookCallback<T = Record<string, unknown>> = (data: T) => void | Promise<void> | false | Promise<false>

/**
 * Map of hook names to their callbacks.
 * All hooks are optional.
 */
export type ModelHooks = {
  [K in HookName]?: HookCallback
}

/**
 * Execute a model hook if it exists.
 *
 * @param hooks - The hooks object from the model
 * @param name - The hook name to execute
 * @param data - The data to pass to the hook
 * @returns `false` if the hook explicitly returned false (operation should be aborted), otherwise `true`
 */
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
