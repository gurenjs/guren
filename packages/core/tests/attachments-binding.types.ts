/**
 * Type-level test for the `attachments` ServiceBindings augmentation (RFC 0023
 * §1). Compiled by the root `tsc --noEmit`; never executed.
 */
import type { Container } from '@guren/server'
import type { AttachmentEngine } from '../src/attachments/engine'
import '../src/attachments/index'

declare const container: Container

export const engine: AttachmentEngine = container.make('attachments')
