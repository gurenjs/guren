/**
 * The `issues:` frontmatter field (RFC 0018): how a doc names the GitHub
 * issues or pull requests it belongs to, and how a consumer turns one into a
 * label and a URL. Everything here is offline: shape is validated, existence
 * never is, so `guren check` stays a deterministic gate.
 */
import { splitCommaList } from './utils'

export type DocIssueRef =
  | {
      kind: 'github'
      /** `owner/repo`, or null when the entry names the app's own repository. */
      repo: string | null
      number: number
    }
  | {
      /** An http(s) URL on some other host: an outlink the viewer can render, nothing more. */
      kind: 'url'
      url: string
    }

/** What a consumer shows for one reference; `url` is absent when no repository is known. */
export interface IssueLink {
  /** `owner/repo#412`, `#412` when no repository is known, or the URL. */
  label: string
  url?: string
}

/** The accepted spellings, in the order the fix text lists them. */
export const ISSUE_REF_FORMS =
  '412, "#412", owner/repo#412, or an issue/PR URL (no spaces, quotes, commas or backslashes)'

const REPO_SEGMENT = '[A-Za-z0-9_.-]+'
// A URL character set that survives every place a reference travels: the
// comma-split `--issue` list, the double-quoted YAML scalar make:adr writes,
// and the inline-list frontmatter the scanner splits on unquoted commas.
const URL_CHARS = '[^\\s",\\\\]'
const GITHUB_FORMS = [
  /^#?(?<number>\d+)$/,
  new RegExp(`^(?<repo>${REPO_SEGMENT}/${REPO_SEGMENT})#(?<number>\\d+)$`),
  new RegExp(
    `^https?://(?:www\\.)?github\\.com/(?<repo>${REPO_SEGMENT}/${REPO_SEGMENT})/(?:issues|pull)/(?<number>\\d+)(?:[/?#]${URL_CHARS}*)?$`,
  ),
]
const URL_RE = new RegExp(`^https?://${URL_CHARS}+$`)

/** Parse one `issues:` entry, or null when it matches no accepted form. */
export function parseIssueRef(raw: string): DocIssueRef | null {
  const entry = raw.trim()

  for (const form of GITHUB_FORMS) {
    const groups = form.exec(entry)?.groups
    if (!groups) continue
    const number = Number(groups.number)
    return Number.isSafeInteger(number) && number > 0
      ? { kind: 'github', repo: groups.repo ?? null, number }
      : null
  }

  return URL_RE.test(entry) ? { kind: 'url', url: entry } : null
}

/** The `--issue` flag's value as entries: comma-separated, blanks dropped. */
export function splitIssueList(value: string | undefined): string[] {
  return value === undefined ? [] : splitCommaList(value)
}

/**
 * Label and URL for one reference. The label doubles as the identity across
 * docs: `412` and `acme/shop#412` in a checkout whose origin is acme/shop
 * describe one issue and get one label.
 */
export function describeIssue(ref: DocIssueRef, defaultRepo: string | null): IssueLink {
  if (ref.kind === 'url') return { label: ref.url, url: ref.url }
  const repo = ref.repo ?? defaultRepo
  return repo
    ? { label: `${repo}#${ref.number}`, url: `https://github.com/${repo}/issues/${ref.number}` }
    : { label: `#${ref.number}` }
}
