import { appDependsOn, fileExists } from './discovery'
import { DEFAULT_ROUTES_FILE } from './route-registrar'

/**
 * Every filename an app's web routes entry can have. `.js` is not hypothetical
 * — `doctor` accepts it too — and this predicate only reads the list to decide
 * that *none* of them is present, so a name missing here refuses a real app.
 */
const WEB_ROUTES_CANDIDATES = [DEFAULT_ROUTES_FILE, 'routes/web.js'] as const

/**
 * The one rule for "this app cannot render an Inertia page", for scaffolders
 * that emit a page component, a controller importing `@/.guren/pages.gen`, or a
 * route wired into `routes/web.ts`. On an app scaffolded from the `api`
 * blueprint the files they write are worse than nothing: the controller does
 * not typecheck against a missing `@guren/inertia-client`, and the routes file
 * is mounted by nothing.
 *
 * Distinct from `appEmitsPageManifest` in `pages-types.ts`, which asks whether
 * codegen would write a pages manifest and answers from the page components on
 * disk. That signal cannot back a refusal — a fullstack app that has not
 * written its first page yet has none either.
 *
 * **Positive evidence only — every "cannot tell" answers `false`.** The cost of
 * the two mistakes is not symmetric: failing to recognize an API-only app
 * leaves the mess callers already handle today, while wrongly accusing one
 * blocks a command that would have worked. Both signals are therefore required,
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
 * Refuses to scaffold Inertia-shaped output into a confirmed API-only app —
 * `isConfirmedApiOnlyApp` plus the refusal, one call, so the check and the
 * message naming its two signals cannot drift apart. Callers supply only what
 * their own command would have written and what to do instead.
 *
 * `command` is the whole invocation the developer typed, because one scaffolder
 * backs more than one of them — `makeFeature` is reached as both `guren add
 * resource` and `guren make:feature` — and a refusal naming the other sends
 * them to the wrong docs page.
 *
 * Deliberately not called by the single-file generators (`make:controller`
 * emits an Inertia controller, `make:view` a page component): one file is a
 * deletion, not the multi-file mess this guard exists to prevent, and their
 * templates are the thing to make dialect-aware if that ever changes.
 */
export async function assertNotApiOnlyApp(cwd: string, options: {
  /** Full invocation, e.g. `guren add admin` or `guren make:feature`. */
  command: string
  /** What the command would have written, phrased as the object of "scaffolds". */
  scaffolds: string
  /** What to do instead of running it here — one clause, no trailing period. */
  remedy: string
}): Promise<void> {
  if (!(await isConfirmedApiOnlyApp(cwd))) return

  const { command, scaffolds, remedy } = options
  throw new Error(
    `${command} scaffolds ${scaffolds}, but this app has no @guren/inertia-client `
    + `dependency and no routes/web.ts. ${remedy}, or scaffold a fullstack app.`,
  )
}
