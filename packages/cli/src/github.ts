/**
 * The GitHub side of RFC 0018: which repository the app is, and what `gh`
 * says about an issue when a caller asks for live state. Nothing here runs
 * inside `guren check`, `gate`, or a hook; `--live` is the only entry point
 * and it degrades to a reason string rather than an exit code.
 */
import { spawn } from 'node:child_process'
import { runGit } from './changed-files'

const REPO_SEGMENT = '[A-Za-z0-9_.-]+'
const REPO_SLUG_RE = new RegExp(`^${REPO_SEGMENT}/${REPO_SEGMENT}$`)
const REMOTE_RE = new RegExp(
  `^(?:https?://(?:[^@/]+@)?github\\.com/|(?:ssh://)?git@github\\.com[:/])(${REPO_SEGMENT}/${REPO_SEGMENT})$`,
)

/** Whether `value` is an `owner/name` slug, the form `--repo` takes. */
export function isRepoSlug(value: string): boolean {
  return REPO_SLUG_RE.test(value)
}

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

/** How `gh` is invoked; tests substitute a stub so no network is ever needed. */
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>

export const GH_TIMEOUT_MS = 5_000

/**
 * Run `gh` and hand back stdout, or the one line that explains why not: a
 * missing binary, a timeout, or the first stderr line of a failed exit (`gh`
 * puts its "not logged in" and rate-limit messages there).
 */
export function runGh(args: string[], cwd: string, timeoutMs = GH_TIMEOUT_MS): Promise<GhResult> {
  return new Promise((settle) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('gh', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      settle({ ok: false, reason: `gh could not start: ${(error as Error).message}`, stdout: '' })
      return
    }

    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result: GhResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      settle(result)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, reason: `gh timed out after ${timeoutMs}ms`, stdout })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason: error.code === 'ENOENT' ? 'gh not found on PATH' : `gh could not start: ${error.message}`,
        stdout,
      })
    })
    child.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true, stdout })
        return
      }
      const detail = stderr.split(/\r?\n/).find((line) => line.trim() !== '')
      finish({ ok: false, reason: `gh exited ${code}${detail ? `: ${detail.trim()}` : ''}`, stdout })
    })
  })
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

function toLiveIssue(node: GraphqlIssue): LiveIssue | null {
  if (typeof node.title !== 'string' || typeof node.state !== 'string') return null
  const names = (nodes: Array<Record<string, unknown>> | undefined, key: string): string[] =>
    (nodes ?? []).map((entry) => entry[key]).filter((value): value is string => typeof value === 'string')
  return {
    title: node.title,
    state: node.state.toLowerCase() as LiveIssue['state'],
    assignees: names(node.assignees?.nodes, 'login'),
    labels: names(node.labels?.nodes, 'name'),
    updatedAt: typeof node.updatedAt === 'string' ? node.updatedAt : '',
  }
}

/** The `repository` object in a GraphQL body, whatever the exit code was; null when there is none. */
function repositoryData(stdout: string): Record<string, GraphqlIssue | null> | null {
  try {
    const repository = (JSON.parse(stdout) as { data?: { repository?: unknown } }).data?.repository
    return repository !== null && typeof repository === 'object' ? (repository as Record<string, GraphqlIssue | null>) : null
  } catch {
    return null
  }
}

/**
 * Current state for the given issues, grouped by repository. A repository
 * whose body carries no data (not logged in, rate limited, unreachable) stops
 * the lookup and reports why; an unknown number only leaves its own entry
 * absent. The numbers, not the bodies, are what travels to GitHub.
 */
export async function fetchLiveIssues(
  targets: IssueTarget[],
  cwd: string,
  run: GhRunner = runGh,
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
    const result = await run(
      ['api', 'graphql', '-f', `query=${liveIssueQuery(numbers)}`, '-f', `owner=${owner}`, '-f', `name=${name}`],
      cwd,
    )
    const repository = repositoryData(result.stdout)
    if (repository === null) {
      return { live, error: result.ok ? `gh returned no data for ${repo}` : result.reason }
    }
    for (const number of numbers) {
      const node = repository[`i${number}`]
      const issue = node ? toLiveIssue(node) : null
      if (issue) live.set(`${repo}#${number}`, issue)
    }
  }
  return { live }
}
