import { warnOnce } from './warn-once'

/** The name-keyed class registries a queued message is resolved back through. */
export type ClassRegistryKind = 'job' | 'event' | 'notification'

interface NamedClass {
  readonly name: string
}

const ADVICE: Record<ClassRegistryKind, string> = {
  job: 'A queued message runs whichever registered last. ' +
    'Give one a different class name or its own static jobName.',
  event: "Listeners are keyed by the name, so each class's listeners also run for the other's emits, " +
    'and a queued emit is rebuilt as whichever registered last. ' +
    'Give one a different class name or its own static eventName.',
  notification: 'A queued notification is rebuilt as whichever registered last. ' +
    'Give one a different class name or override its type getter.',
}

function label(cls: NamedClass): string {
  return cls.name === '' ? '(anonymous class)' : cls.name
}

/**
 * Warns when a different class takes a name another class holds; the same class
 * again is silent. The caller still overwrites, last wins, so only the log
 * changes. A future major will throw here instead.
 */
export function reportRegistryCollision(
  kind: ClassRegistryKind,
  name: string,
  taken: NamedClass | undefined,
  incoming: NamedClass,
): void {
  if (taken === undefined || taken === incoming) return

  const classes = taken.name === incoming.name
    ? `both named ${label(taken)}`
    : `${label(taken)} and ${label(incoming)}`
  warnOnce(
    `registry-collision:${kind}:${name}`,
    `[guren] Two different ${kind} classes are registered as "${name}" (${classes}). ` +
      `${ADVICE[kind]} A future major will throw here instead.`,
  )
}
