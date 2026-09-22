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
  method: string = operation,
) {
  // Held for the whole write, so replacing `hooks` or calling `observe()` /
  // `clearObservers()` inside a callback applies from the next write. The array
  // is copied because `observe()` pushes into it; the hooks object is not,
  // since each hook is called as its method.
  const observerList = observers?.slice()
  const { before: beforeEvents, after: afterEvents } = events[operation]
  return {
    async before(data: Record<string, unknown>): Promise<void> {
      for (const name of beforeEvents) {
        if (!(await executeHook(hooks, name, data))) {
          throw new Error(`${modelName}.${method}() aborted by '${name}' hook.`)
        }
      }
      for (const name of beforeEvents) {
        if (!(await executeObservers(observerList, name, data))) {
          throw new Error(`${modelName}.${method}() aborted by observer '${name}'.`)
        }
      }
    },
    async after(data: Record<string, unknown>): Promise<void> {
      // After callbacks cannot cancel persistence.
      for (const name of afterEvents) await executeHook(hooks, name, data)
      for (const name of afterEvents) await executeObservers(observerList, name, data)
    },
  }
}
