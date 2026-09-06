/**
 * The application's one handle on its own agent. Both operator surfaces reach
 * it the same way — through the Durable Object binding, never over HTTP — so
 * the JSON API and the browser console cannot disagree about which instance
 * they drive.
 */
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import type { Env, TriagerStub } from '../../config/env'

/** One triager for the whole application. A per-tenant demo would derive this. */
const INSTANCE = 'main'

export const TRIAGER_UNAVAILABLE =
  'Agents run on Workers. Start this app with `wrangler dev --local`; '
  + 'under `bun run dev` there is no Durable Object namespace to address.'

/** `null` off workerd, and on a worker whose wrangler.jsonc binds no namespace. */
export function triagerStub(): TriagerStub | null {
  if (!isWorkersRuntime()) return null
  const namespace = getWorkersEnv<Env>().TRIAGER
  if (!namespace) return null
  return namespace.get(namespace.idFromName(INSTANCE))
}
