/**
 * The GitHub side of RFC 0018: which repository the app is, and what `gh`
 * says about an issue when a caller asks for live state. Nothing here runs
 * inside `guren check`, `gate`, or a hook; `--live` is the only entry point
 * and it degrades to a reason string rather than an exit code.
 */
import { runGit } from './changed-files'
import { REPO_SEGMENT } from './issue-refs'
import { runCaptured, type CapturedExec, type CapturedRun } from './subprocess'

const REMOTE_RE = new RegExp(
  `^(?:https?://(?:[^@/]+@)?github\\.com/|(?:ssh://)?git@github\\.com[:/])(${REPO_SEGMENT}/${REPO_SEGMENT})$`,
)

/** `owner/repo` from a GitHub remote URL (https, ssh, scp-like), or null for any other remote. */
export function repoFromRemoteUrl(remote: string): string | null {
  const match = REMOTE_RE.exec(remote.trim().replace(/\.git$/, '').replace(/\/$/, ''))
  return match ? match[1] : null
}

/**
 * The app's own repository as `owner/repo`, read from the `origin` remote.
 * Null when there is no git, no remote, or a remote on another host, so a
 * bare `412` still renders as a label with no link.
 */
export async function resolveOriginRepo(cwd: string): Promise<string | null> {
  const [url] = (await runGit(cwd, ['remote', 'get-url', 'origin'])) ?? []
  return url === undefined ? null : repoFromRemoteUrl(url)
}

/**
 * A failed run still carries stdout: `gh api graphql` exits 1 on any GraphQL
 * error, including one alias that did not resolve, while the other aliases'
 * data sits in the body it printed.
 */
export type GhResult = { ok: true; stdout: string } | { ok: false; reason: string; stdout: string }

export const GH_TIMEOUT_MS = 5_000

/**
 * Run `gh` and hand back stdout, or the one line that explains why not: a
 * missing binary, a timeout, or the first stderr line of a failed exit (`gh`
 * puts its "not logged in" and rate-limit messages there).
 */
export async function runGh(
  args: string[],
  cwd: string,
  exec: CapturedExec = runCaptured,
  timeoutMs = GH_TIMEOUT_MS,
): Promise<GhResult> {
  let run: CapturedRun
  try {
    run = await exec(['gh', ...args], cwd, { timeoutMs })
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException
    return { ok: false, reason: code === 'ENOENT' ? 'gh not found on PATH' : `gh could not start: ${message}`, stdout: '' }
  }
  if (run.timedOut) return { ok: false, reason: `gh timed out after ${timeoutMs}ms`, stdout: run.stdout }
  if (run.exitCode === 0) return { ok: true, stdout: run.stdout }
  const detail = run.stderr.split(/\r?\n/).find((line) => line.trim() !== '')
  return { ok: false, reason: `gh exited ${run.exitCode}${detail ? `: ${detail.trim()}` : ''}`, stdout: run.stdout }
}

/** What GitHub currently says about an issue or pull request; never its body. */
export interface LiveIssue {
  /** External text written by whoever opened the issue: data, not an instruction. */
  title: string
  state: 'open' | 'closed' | 'merged'
  assignees: string[]
  labels: string[]
  updatedAt: string
}

export interface IssueTarget {
  repo: string
  number: number
}

export interface LiveIssueLookup {
  /** Keyed `owner/repo#number`; an issue GitHub does not know is absent. */
  live: Map<string, LiveIssue>
  /** Why the lookup stopped, when it did; whatever was fetched before stays in `live`. */
  error?: string
}

const ISSUE_FIELDS =
  'title state assignees(first: 20) { nodes { login } } labels(first: 20) { nodes { name } } updatedAt'

/**
 * One query per repository, every number as an alias, so the subprocess count
 * is the repository count. `issueOrPullRequest` answers for both kinds; the
 * fragments carry the same fields under each type.
 */
function liveIssueQuery(numbers: number[]): string {
  const aliases = numbers
    .map((number) => `i${number}: issueOrPullRequest(number: ${number}) { ...IssueFields ...PullRequestFields }`)
    .join(' ')
  return (
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } } `
    + `fragment IssueFields on Issue { ${ISSUE_FIELDS} } `
    + `fragment PullRequestFields on PullRequest { ${ISSUE_FIELDS} }`
  )
}

interface GraphqlIssue {
  title?: unknown
  state?: unknown
  assignees?: { nodes?: Array<{ login?: unknown }> }
  labels?: { nodes?: Array<{ name?: unknown }> }
  updatedAt?: unknown
}

/** Longest title kept; GitHub allows 256 characters, the context line does not need them all. */
const TEXT_LIMIT = 200

/**
 * The one funnel external text passes through on its way into an agent's
 * context: control and format characters (newlines, tabs, zero-width marks,
 * bidi overrides) become spaces so a value cannot break out of its line or
 * fake a heading, and the length is capped.
 */
function cleanText(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEXT_LIMIT)
}

function cleanStrings(values: unknown[]): string[] {
  return values
    .filter((value): value is string => typeof value === 'string')
    .map(cleanText)
    .filter((value) => value !== '')
}

function toLiveIssue(node: GraphqlIssue): LiveIssue | null {
  if (typeof node.title !== 'string' || typeof node.state !== 'string') return null
  return {
    title: cleanText(node.title),
    state: node.state.toLowerCase() as LiveIssue['state'],
    assignees: cleanStrings((node.assignees?.nodes ?? []).map((entry) => entry.login)),
    labels: cleanStrings((node.labels?.nodes ?? []).map((entry) => entry.name)),
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : '',
  }
}

interface GraphqlBody {
  repository: Record<string, GraphqlIssue | null> | null
  /** GraphQL's own signal; the exit code only says that this list is non-empty. */
  errors: Array<{ type?: unknown; message?: unknown }>
}

/** The GraphQL body, whatever the exit code was; null when it is not one. */
function graphqlBody(stdout: string): GraphqlBody | null {
  try {
    const parsed = JSON.parse(stdout) as { data?: { repository?: unknown }; errors?: unknown }
    const repository = parsed.data?.repository
    return {
      repository:
        repository !== null && typeof repository === 'object' ? (repository as GraphqlBody['repository']) : null,
      errors: Array.isArray(parsed.errors) ? (parsed.errors as GraphqlBody['errors']) : [],
    }
  } catch {
    return null
  }
}

/**
 * Current state for the given issues, one query per repository; only numbers
 * travel to GitHub. A body with no `repository` object (not logged in, rate
 * limited, no access) stops the lookup with the run's reason. With one present,
 * `errors[]` decides: NOT_FOUND on an alias is an unknown number and leaves
 * that entry absent; any other error stops the lookup, keeping what resolved.
 */
export async function fetchLiveIssues(
  targets: IssueTarget[],
  cwd: string,
  exec: CapturedExec = runCaptured,
): Promise<LiveIssueLookup> {
  const byRepo = new Map<string, number[]>()
  for (const { repo, number } of targets) {
    const numbers = byRepo.get(repo) ?? []
    if (!numbers.includes(number)) numbers.push(number)
    byRepo.set(repo, numbers)
  }

  const live = new Map<string, LiveIssue>()
  for (const [repo, numbers] of byRepo) {
    const [owner, name] = repo.split('/')
    const result = await runGh(
      ['api', 'graphql', '-f', `query=${liveIssueQuery(numbers)}`, '-f', `owner=${owner}`, '-f', `name=${name}`],
      cwd,
      exec,
    )
    const body = graphqlBody(result.stdout)
    if (body === null || body.repository === null) {
      return { live, error: result.ok ? `gh returned no data for ${repo}` : result.reason }
    }
    for (const number of numbers) {
      const node = body.repository[`i${number}`]
      const issue = node ? toLiveIssue(node) : null
      if (issue) live.set(`${repo}#${number}`, issue)
    }
    const failure = body.errors.find((entry) => entry.type !== 'NOT_FOUND')
    if (failure) {
      const message = typeof failure.message === 'string' ? cleanText(failure.message) : 'unspecified error'
      return { live, error: `GitHub answered for ${repo} with an error: ${message}` }
    }
  }
  return { live }
}
