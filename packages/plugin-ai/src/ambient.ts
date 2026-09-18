/**
 * The `ai` binding on the default application (RFC 0023 §3), for a caller with
 * no manager to pass: `Agent`'s statics and the `embed()` / `image()` wrappers.
 * Its own module so neither importer closes a cycle through {@link AiManager}.
 */
import { ambientBinding } from '@guren/core'

import type { AiManager } from './manager'

export function ambientManager(caller: string, alternative: string): AiManager {
  // `ambientBinding` rather than has() + make(): it counts a container.fake() and
  // activates a deferred provider, which has() does not see.
  const manager = ambientBinding('ai')
  if (!manager) {
    throw new Error(
      `${caller} resolves the \`ai\` manager from the default application, and none is bound. `
      + `Add config/ai.ts (defineAiConfig) to createApp({ config }), or ${alternative}.`,
    )
  }
  return manager
}
