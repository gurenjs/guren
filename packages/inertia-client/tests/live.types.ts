import type { LiveOption } from '@inertiajs/core'
import type { StartInertiaClientOptions } from '../src/app'
import { liveTransport, type AnyLiveTransport, type LiveOptions } from '../src/live'

/**
 * A type-only fixture: `bun run typecheck` is the assertion. The live module
 * restates Inertia 3.11's transport types so it admits an older Inertia, and
 * the two must stay assignable both ways.
 */

export const options: LiveOption = liveTransport({ throttle: 2000 })
export const transport: LiveOption = liveTransport().transport
export const toInertia = (option: LiveOptions | AnyLiveTransport): LiveOption => option
export const fromInertia = (option: LiveOption): StartInertiaClientOptions['live'] => option
