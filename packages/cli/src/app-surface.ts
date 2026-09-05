import { appDependsOn, fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE } from './route-registrar'

/**
 * Every filename an app's web routes entry can have. The predicate reads the
 * list to decide that *none* is present, so a name missing here refuses a real app.
 */
const WEB_ROUTES_CANDIDATES = [DEFAULT_ROUTES_FILE, 'routes/web.js'] as const

/**
 * The wording every report of these signals shares. It lives with the predicate
 * so adding or dropping a signal cannot leave each caller's description stale.
 */
export const API_ONLY_EVIDENCE =
  `no @guren/inertia-client dependency and no ${DEFAULT_ROUTES_FILE}`

/**
 * The one rule for "this app cannot render an Inertia page", for scaffolders that
 * emit a page, import `@/.guren/pages.gen`, or wire a `routes/web.ts` route.
 * **Positive evidence only — every "cannot tell" answers `false`**: a wrong
 * accusation blocks a command that would have worked. Both signals are required
 * since each alone is ambiguous; a stale `routes/web.ts` is the accepted blind spot.
 */
export async function isConfirmedApiOnlyApp(cwd: string): Promise<boolean> {
  // `null` is "there was no manifest to ask", which is not evidence of anything.
  const manifestLacksInertiaClient = (await appDependsOn(cwd, '@guren/inertia-client')) === false

  if (!manifestLacksInertiaClient) {
    return false
  }

  const webRoutes = await Promise.all(WEB_ROUTES_CANDIDATES.map((file) => fileExists(cwd, file)))
  return !webRoutes.includes(true)
}

/**
 * Refuses an API-only app on a scaffolder's behalf, before its first write.
 * `does` completes "guren add x scaffolds …" and `instead` is the whole
 * alternative sentence, which differs per command.
 */
export async function assertNotApiOnly(
  cwd: string,
  { does, instead }: { does: string; instead: string },
): Promise<void> {
  if (!(await isConfirmedApiOnlyApp(cwd))) return

  throw new Error(
    `${does}, but this app has no @guren/inertia-client dependency and no ${DEFAULT_ROUTES_FILE}. `
    + `${instead}, or scaffold a fullstack app.`,
  )
}
