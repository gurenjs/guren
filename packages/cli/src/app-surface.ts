import { appDependsOn, fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE } from './route-registrar'

/**
 * Every filename an app's web routes entry can have. `.js` is not hypothetical
 * — `doctor` accepts it too — and this predicate only reads the list to decide
 * that *none* of them is present, so a name missing here refuses a real app.
 */
const WEB_ROUTES_CANDIDATES = [DEFAULT_ROUTES_FILE, 'routes/web.js'] as const

/**
 * The signals this module read, in the wording every report of them shares —
 * refusals, and codegen declining to write a pages manifest. It belongs to the
 * predicate rather than to each caller: they supplied it themselves until there
 * were several saying it in several places, and a signal added or dropped below
 * would have left every description stale independently.
 */
export const API_ONLY_EVIDENCE =
  `no @guren/inertia-client dependency and no ${DEFAULT_ROUTES_FILE}`

/**
 * The one rule for "this app cannot render an Inertia page", for scaffolders
 * that emit a page component, a controller importing `@/.guren/pages.gen`, or a
 * route wired into `routes/web.ts`. On an app scaffolded from the `api`
 * blueprint the files they write are worse than nothing: the controller does
 * not typecheck against a missing `@guren/inertia-client`, and the routes file
 * is mounted by nothing.
 *
 * Callers either refuse on a `true` (via `assertNotApiOnly` below) or, where
 * their output has an API dialect, adapt what they emit instead.
 *
 * `planPageManifest` in `pages-types.ts` is the third kind: codegen declines to
 * write `.guren/pages.gen.ts` into an app this recognizes, because that module
 * imports the missing `@guren/inertia-client`. Page components on disk are the
 * input it adds, and they cannot back a refusal on their own — a fullstack app
 * that has not written its first page has none either.
 *
 * **Positive evidence only — every "cannot tell" answers `false`.** The cost of
 * the two mistakes is not symmetric: failing to recognize an API-only app
 * leaves the mess callers already handle today, while wrongly accusing one
 * blocks a command that would have worked — or, for the adapting caller, hands
 * a fullstack app the wrong dialect. Both signals are therefore required,
 * and each is individually ambiguous: `@guren/inertia-client` is the stronger
 * of the two but is read from a `package.json` that may be absent or hoisted to
 * a workspace root, and an app with no web routes entry may just be a fullstack
 * app whose registrar lives somewhere the route wiring will report on.
 *
 * The accepted blind spot is the reverse: an API-only app carrying a stale
 * `routes/web.ts` is not recognized. Closing it would mean deciding which entry
 * `src/app.ts` actually mounts, and guessing wrong there refuses working apps.
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
 *
 * The middle of the message is {@link API_ONLY_EVIDENCE}, for the reason stated
 * there.
 *
 * `does` completes "guren add x scaffolds …" and `instead` is the whole
 * alternative sentence, because what an app should do without this scaffold
 * differs per command in a way no template can derive.
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
