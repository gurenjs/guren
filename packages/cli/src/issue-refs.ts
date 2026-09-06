/**
 * The `issues:` frontmatter field (RFC 0018): how a doc names the GitHub
 * issues or pull requests it belongs to, and how a consumer turns one into a
 * label and a URL. Everything here is offline: shape is validated, existence
 * never is, so `guren check` stays a deterministic gate.
 */
import { runGit } from './changed-files'

export type DocIssueRef =
  | {
      kind: 'github'
      /** The entry as written, for messages. */
      raw: string
      /** `owner/repo`, or null when the entry names the app's own repository. */
      repo: string | null
      number: number
    }
  | {
      /** An http(s) URL on some other host: an outlink the viewer can render, nothing more. */
      kind: 'url'
      raw: string
      url: string
    }

/** The accepted spellings, in the order the fix text lists them. */
export const ISSUE_REF_FORMS = '412, "#412", owner/repo#412, or an issue/PR URL'

const NUMBER_RE = /^#?(\d+)$/
const REPO_SEGMENT = '[A-Za-z0-9_.-]+'
const REPO_NUMBER_RE = new RegExp(`^(${REPO_SEGMENT}/${REPO_SEGMENT})#(\\d+)$`)
const GITHUB_URL_RE = new RegExp(
  `^https?://(?:www\\.)?github\\.com/(${REPO_SEGMENT}/${REPO_SEGMENT})/(?:issues|pull)/(\\d+)(?:[/?#].*)?$`,
)

/** Parse one `issues:` entry, or null when it matches no accepted form. */
export function parseIssueRef(raw: string): DocIssueRef | null {
  const entry = raw.trim()
  if (entry === '') return null

  const bare = NUMBER_RE.exec(entry)
  if (bare) return { kind: 'github', raw: entry, repo: null, number: Number(bare[1]) }

  const scoped = REPO_NUMBER_RE.exec(entry)
  if (scoped) return { kind: 'github', raw: entry, repo: scoped[1], number: Number(scoped[2]) }

  const github = GITHUB_URL_RE.exec(entry)
  if (github) return { kind: 'github', raw: entry, repo: github[1], number: Number(github[2]) }

  if (/^https?:\/\/\S+$/.test(entry)) return { kind: 'url', raw: entry, url: entry }

  return null
}

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

/** `owner/repo#412`, or `#412` when no repository is known. */
export function issueLabel(ref: DocIssueRef, defaultRepo: string | null): string {
  if (ref.kind === 'url') return ref.url
  const repo = ref.repo ?? defaultRepo
  return repo ? `${repo}#${ref.number}` : `#${ref.number}`
}

/** The issue's URL, or undefined when the repository cannot be resolved. */
export function issueUrl(ref: DocIssueRef, defaultRepo: string | null): string | undefined {
  if (ref.kind === 'url') return ref.url
  const repo = ref.repo ?? defaultRepo
  return repo ? `https://github.com/${repo}/issues/${ref.number}` : undefined
}

/** Identity for de-duplication across docs: the same issue named two ways is one issue. */
export function issueKey(ref: DocIssueRef, defaultRepo: string | null): string {
  if (ref.kind === 'url') return ref.url
  return `${ref.repo ?? defaultRepo ?? ''}#${ref.number}`
}
