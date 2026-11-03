import type { LiveOption } from '@inertiajs/core'
import { liveTransport, type LiveOptions, type LiveTransport } from '../src/live'

/**
 * A type-only fixture: `bun run typecheck` is the assertion. The live module
 * restates Inertia 3.11's transport types so it admits an older Inertia; what
 * it returns must stay assignable to the real ones.
 */

export const options: LiveOption = liveTransport({ throttle: 2000 })
export const transport: LiveOption = liveTransport().transport
export const fromInertia = (option: LiveOptions | LiveTransport): LiveOption => option
