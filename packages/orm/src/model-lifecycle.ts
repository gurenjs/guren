import { executeHook, type HookName, type ModelHooks } from './hooks'
import { executeObservers, type ModelObserver } from './ModelObserver'

const events = {
  create: { before: ['creating', 'saving'], after: ['created', 'saved'] },
  update: { before: ['updating', 'saving'], after: ['updated', 'saved'] },
  delete: { before: ['deleting'], after: ['deleted'] },
} as const satisfies Record<string, { before: readonly HookName[]; after: readonly HookName[] }>

export function modelLifecycle(
  modelName: string,
  operation: keyof typeof events,
  hooks: ModelHooks | undefined,
  observers: ModelObserver[] | undefined,
) {
  // Capture references once: callbacks may replace the model's registrations.
  const { before: beforeEvents, after: afterEvents } = events[operation]
  return {
    async before(data: Record<string, unknown>): Promise<void> {
      for (const name of beforeEvents) {
        if (!(await executeHook(hooks, name, data))) {
          throw new Error(`${modelName}.${operation}() aborted by '${name}' hook.`)
        }
      }
      for (const name of beforeEvents) {
        if (!(await executeObservers(observers, name, data))) {
          throw new Error(`${modelName}.${operation}() aborted by observer '${name}'.`)
        }
      }
    },
    async after(data: Record<string, unknown>): Promise<void> {
      // After callbacks cannot cancel persistence.
      for (const name of afterEvents) await executeHook(hooks, name, data)
      for (const name of afterEvents) await executeObservers(observers, name, data)
    },
  }
}
