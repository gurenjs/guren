import { parseDocFrontmatter } from './docs-frontmatter'
import { safePathSegments } from './utils'

/**
 * The one rule for which files each agent target owns and how the canonical
 * harness content renders into them (RFC 0008), from the agent-neutral `core/`
 * plus per-target `targets/`. `agent-harness.ts` does the I/O and derives sync
 * detection from these same plans — a second mapping is how one rule file lands
 * in two locations with drifting content. Targets collapse onto shared
 * components: every non-Claude agent reads `AGENTS.md` + `.agents/` natively,
 * and cursor/copilot also get those rules re-rendered into native formats.
 */

export const AGENT_TARGETS = ['claude', 'codex', 'cursor', 'copilot', 'opencode'] as const

export type AgentTarget = (typeof AGENT_TARGETS)[number]

/** The independently installable pieces of the harness, in install order. */
const COMPONENT_ORDER = ['claude', 'agents', 'cursor', 'copilot', 'codex', 'opencode'] as const

export type HarnessComponent = (typeof COMPONENT_ORDER)[number]

/**
 * Components whose managed files identify them on disk, letting `agent:sync`
 * re-plan them. codex/opencode are absent: their only distinct files are
 * user-owned extras sync must never re-plan or widen.
 */
export const DETECTABLE_COMPONENTS = [
  'claude',
  'agents',
  'cursor',
  'copilot',
] as const satisfies readonly HarnessComponent[]

export type DetectableComponent = (typeof DETECTABLE_COMPONENTS)[number]

/** Marks an MCP client config as already carrying the Guren endpoint. */
const MCP_ENDPOINT_MARKER = '_guren/mcp'

/**
 * A claim over files the planner owns: anything matching it that the plan does
 * not write is a leftover `agent:sync --prune` may delete. `files` claims named
 * files at a directory's top level, `pattern` only framework-named ones there,
 * `children` named subdirectories recursively. Never a whole root — the skills
 * roots also hold third-party skills (RFC 0011) and the rules roots a project's
 * own conventions, both of which a whole-root claim made prune candidates.
 */
export type ManagedNamespace =
  | { kind: 'files'; dir: string; names: readonly string[] }
  | { kind: 'pattern'; dir: string; prefix: string; suffix: string }
  | { kind: 'children'; dir: string; names: readonly string[] }

type PatternNamespace = Extract<ManagedNamespace, { kind: 'pattern' }>

/**
 * The one spelling of a family root's canonical directories: both the written
 * paths and the prune claims come from here, so a rename cannot leave the claim
 * pointing at the old location, where prune would eat the freshly written files.
 */
function canonicalDirs(root: '.claude' | '.agents'): { rules: string; skills: string } {
  return { rules: `${root}/rules`, skills: `${root}/skills` }
}

/**
 * Tombstones: canonical skill directories the harness once shipped and no
 * longer plans, which prune still owns. Removing a skill from `core/skills/`
 * means adding its old name here — a review obligation, not a testable one,
 * since the repository has no record of what it used to ship.
 */
export const RETIRED_CANONICAL_SKILLS: readonly string[] = []

/**
 * The same discipline as `RETIRED_CANONICAL_SKILLS` for `core/rules/`. Names
 * include the extension as written into the canonical roots (`orm-models.md`);
 * the native `guren-*` re-renderings are claimed by their pattern instead.
 */
export const RETIRED_CANONICAL_RULES: readonly string[] = []

/** Also the path rule `planComponents` writes with, so claim and names cannot drift. */
const CURSOR_RULES_NAMESPACE: PatternNamespace = {
  kind: 'pattern',
  dir: '.cursor/rules',
  prefix: 'guren-',
  suffix: '.mdc',
}

const COPILOT_RULES_NAMESPACE: PatternNamespace = {
  kind: 'pattern',
  dir: '.github/instructions',
  prefix: 'guren-',
  suffix: '.instructions.md',
}

function nativeRulePath(namespace: PatternNamespace, stem: string): string {
  return `${namespace.dir}/${namespace.prefix}${stem}${namespace.suffix}`
}

/**
 * A claimed name must be exactly one plain path segment: it is interpolated
 * into a directory the prune walker will `rm` under, so `..` would claim
 * outside the app. Traversal is `safePathSegments`' rule, never restated here;
 * this adds only the single-segment constraint on top of it. Checked here
 * because `claimFamily` is the sole producer of a `children` claim.
 */
function assertClaimName(name: string, label: 'rule' | 'skill'): void {
  if (safePathSegments(name, `${label} claim`).length !== 1) {
    throw new Error(`Agent harness ${label} claim "${name}" is not a single path segment`)
  }
}

/**
 * Every immediate child the plan writes into, plus the retired names. Derived
 * from the plan rather than listed, so a rename cannot leave the claim behind.
 */
function claimedSkillNames(
  skillsDir: string,
  plan: readonly PlannedFile[],
  retired: readonly string[],
): string[] {
  for (const name of retired) {
    assertClaimName(name, 'skill')
  }
  const names = new Set<string>(retired)
  const prefix = `${skillsDir}/`
  for (const file of plan) {
    if (!file.managed || !file.path.startsWith(prefix)) {
      continue
    }
    const child = file.path.slice(prefix.length).split('/')[0]
    if (child) {
      assertClaimName(child, 'skill')
      names.add(child)
    }
  }
  return [...names].sort()
}

/**
 * Names a prune claim owns beyond the current plan. Defaults to the tombstone
 * constants; passed explicitly only by tests, since those constants are empty today.
 */
export interface RetiredNames {
  rules?: readonly string[]
  skills?: readonly string[]
}

/**
 * Every file the plan writes directly into `rulesDir`, plus the retired names,
 * derived from the plan so a rename cannot leave the claim behind. Planned names
 * stay in the claim even though the walk excludes planned paths: they catch a
 * leftover differing by case alone, which `findStaleManagedFiles` settles by
 * file identity.
 */
function claimedRuleNames(
  rulesDir: string,
  plan: readonly PlannedFile[],
  retired: readonly string[],
): string[] {
  for (const name of retired) {
    assertClaimName(name, 'rule')
  }
  const names = new Set<string>(retired)
  const prefix = `${rulesDir}/`
  for (const file of plan) {
    if (!file.managed || !file.path.startsWith(prefix)) {
      continue
    }
    const name = file.path.slice(prefix.length)
    assertClaimName(name, 'rule')
    names.add(name)
  }
  return [...names].sort()
}

/**
 * The namespaces the given components own — narrower than the managed file set.
 * `.claude/agents/` and `.claude/hooks/` ship managed files but are also the
 * conventional home for user-authored ones, which no name pattern can tell
 * apart, so stale copies there are left to the user rather than pruned.
 */
export function managedNamespaces(
  components: Iterable<HarnessComponent>,
  plan: readonly PlannedFile[],
  retired: RetiredNames = {},
): ManagedNamespace[] {
  const retiredRules = retired.rules ?? RETIRED_CANONICAL_RULES
  const retiredSkills = retired.skills ?? RETIRED_CANONICAL_SKILLS
  const active = new Set<HarnessComponent>(components)
  const namespaces: ManagedNamespace[] = []
  const claimFamily = (root: '.claude' | '.agents'): void => {
    const dirs = canonicalDirs(root)
    namespaces.push(
      { kind: 'files', dir: dirs.rules, names: claimedRuleNames(dirs.rules, plan, retiredRules) },
      {
        kind: 'children',
        dir: dirs.skills,
        names: claimedSkillNames(dirs.skills, plan, retiredSkills),
      },
    )
  }
  if (active.has('claude')) {
    claimFamily('.claude')
  }
  if (active.has('agents')) {
    claimFamily('.agents')
  }
  if (active.has('cursor')) {
    namespaces.push(CURSOR_RULES_NAMESPACE)
  }
  if (active.has('copilot')) {
    namespaces.push(COPILOT_RULES_NAMESPACE)
  }
  return namespaces
}

export interface PlannedFile {
  /** App-relative POSIX path, e.g. `.agents/rules/testing.md`. */
  path: string
  /** Fully rendered content — no template tokens survive planning. */
  content: string
  /** true → `agent:sync` overwrites; false → written once, only `init --force` replaces. */
  managed: boolean
  /**
   * Set on MCP client configs: when the file already exists without this
   * marker, `agent:init` reports the content as a snippet to merge by hand
   * instead of touching a config that may carry unrelated settings.
   */
  mergeMarker?: string
}

/** Template-relative POSIX path → raw content. */
export type TemplateFiles = Map<string, string>

/**
 * Template directories copied wholesale (consumed by iteration, not by name).
 * Everything else must be `get()`-consumed by `planComponents`; the completeness
 * test in `tests/agent-targets.test.ts` fails on a file reachable by neither.
 */
export const BULK_TEMPLATE_PREFIXES = [
  'core/rules/',
  'core/skills/',
  'targets/claude/agents/',
  'targets/claude/hooks/',
] as const

/**
 * Parse a `--target` value: comma-separated names, or `all`. Every entry is
 * validated before `all` expands, so a typo never silently installs anything.
 */
export function parseTargetList(raw: string): AgentTarget[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  const targets: AgentTarget[] = []
  let all = false
  for (const part of parts) {
    if (part === 'all') {
      all = true
      continue
    }
    if (!(AGENT_TARGETS as readonly string[]).includes(part)) {
      throw new Error(
        `Unknown agent target "${part}". Valid targets: ${AGENT_TARGETS.join(', ')}, all.`,
      )
    }
    if (!targets.includes(part as AgentTarget)) {
      targets.push(part as AgentTarget)
    }
  }
  if (all) {
    return [...AGENT_TARGETS]
  }
  if (targets.length === 0) {
    throw new Error(`No agent targets given. Valid targets: ${AGENT_TARGETS.join(', ')}, all.`)
  }
  return targets
}

/**
 * Order components and restore the install invariant: every non-Claude tool
 * implies the shared agents family. `agent:sync` funnels detected components
 * through this too, so a deleted `.agents/` tree is recreated rather than left
 * referenced by freshly refreshed native rules.
 */
export function normalizeComponents(components: Iterable<HarnessComponent>): HarnessComponent[] {
  const active = new Set<HarnessComponent>(components)
  if ([...active].some((component) => component !== 'claude' && component !== 'agents')) {
    active.add('agents')
  }
  return COMPONENT_ORDER.filter((component) => active.has(component))
}

export function componentsForTargets(targets: AgentTarget[]): HarnessComponent[] {
  // every target name is also its component name
  return normalizeComponents(targets)
}

const RULES_DIR_TOKEN = '__RULES_DIR__'
const APP_TITLE_TOKEN = '__APP_TITLE__'
const TOKEN_RE = /__[A-Z][A-Z_]*__/u

interface RuleDoc {
  description: string
  globs: string[]
  /** Everything after the closing `---`. */
  body: string
}

/**
 * The format is framework-authored, so validation is strict on purpose: an
 * unreadable rule must fail the install rather than ship to Cursor/Copilot with
 * an empty scope.
 */
function parseRuleDoc(name: string, content: string): RuleDoc {
  const parsed = parseDocFrontmatter(content)
  const description = typeof parsed?.data.description === 'string' ? parsed.data.description : ''
  const globs = Array.isArray(parsed?.data.globs)
    ? parsed.data.globs.filter((glob): glob is string => typeof glob === 'string')
    : []
  if (!parsed || !description || globs.length === 0) {
    throw new Error(`Agent harness rule ${name} needs a description and at least one glob`)
  }
  return { description, globs, body: parsed.body }
}

/** Cursor rule: `.mdc` frontmatter with a comma-joined glob string. */
function renderCursorRule(doc: RuleDoc): string {
  return `---\ndescription: ${doc.description}\nglobs: ${doc.globs.join(',')}\nalwaysApply: false\n---\n${doc.body}`
}

/** Copilot instructions: `applyTo` carries the comma-joined glob string. */
function renderCopilotRule(doc: RuleDoc): string {
  return `---\ndescription: ${doc.description}\napplyTo: "${doc.globs.join(',')}"\n---\n${doc.body}`
}

export function planComponents(
  components: HarnessComponent[],
  templates: TemplateFiles,
  appTitle: string,
): PlannedFile[] {
  const planned = new Map<string, PlannedFile>()
  const add = (file: PlannedFile): void => {
    const leftover = TOKEN_RE.exec(file.content)
    if (leftover) {
      throw new Error(`Agent harness left ${leftover[0]} unrendered in ${file.path}`)
    }
    const existing = planned.get(file.path)
    if (existing) {
      if (existing.content !== file.content) {
        throw new Error(`Agent harness planned conflicting content for ${file.path}`)
      }
      return
    }
    planned.set(file.path, file)
  }
  const get = (templatePath: string): string => {
    const content = templates.get(templatePath)
    if (content === undefined) {
      throw new Error(`Agent harness template is missing ${templatePath}`)
    }
    return content
  }
  const under = (prefix: string): Array<[rel: string, content: string]> =>
    [...templates]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, content]) => [path.slice(prefix.length), content])

  const render = (content: string, rulesDir?: string): string => {
    const withTitle = content.replaceAll(APP_TITLE_TOKEN, appTitle)
    return rulesDir === undefined ? withTitle : withTitle.replaceAll(RULES_DIR_TOKEN, rulesDir)
  }

  /**
   * The workflow fragment owns its own headings and ends with its target's
   * lead-in to the catalog; catalog and body stay target-neutral apart from
   * __RULES_DIR__.
   */
  const entryDoc = (workflowPath: string, rulesDir: string): string =>
    render(
      `${get('core/entry-intro.md')}\n${get(workflowPath)}\n${get('core/rules-catalog.md')}\n${get('core/entry-body.md')}`,
      rulesDir,
    )

  /** Every MCP client config is user-owned and merge-hinted the same way. */
  const addMcpConfig = (path: string, templatePath: string): void =>
    add({
      path,
      content: get(templatePath),
      managed: false,
      mergeMarker: MCP_ENDPOINT_MARKER,
    })

  /** The canonical rules + skills trees, rendered for one root directory. */
  const addCanonical = (root: '.claude' | '.agents'): void => {
    const dirs = canonicalDirs(root)
    for (const [rel, content] of under('core/rules/')) {
      // Every claim scans a directory's top level only, so a nested rule would
      // install fine and then be unprunable. Refused here, nowhere else.
      if (rel.includes('/')) {
        throw new Error(
          `Agent harness rule ${rel} must be a flat file — a nested rule cannot be claimed for pruning`,
        )
      }
      add({ path: `${dirs.rules}/${rel}`, content: render(content), managed: true })
    }
    for (const [rel, content] of under('core/skills/')) {
      add({ path: `${dirs.skills}/${rel}`, content: render(content, dirs.rules), managed: true })
    }
  }

  if (components.includes('claude')) {
    // Claude Code does not read AGENTS.md, so it always gets the full CLAUDE.md
    // — even next to an AGENTS.md for other agents.
    add({
      path: 'CLAUDE.md',
      content: entryDoc('targets/claude/workflow.md', canonicalDirs('.claude').rules),
      managed: false,
    })
    addMcpConfig('.mcp.json', 'targets/claude/mcp.json')
    add({
      path: '.claude/settings.json',
      content: get('targets/claude/settings.json'),
      managed: false,
    })
    for (const [rel, content] of under('targets/claude/agents/')) {
      add({ path: `.claude/agents/${rel}`, content: render(content), managed: true })
    }
    for (const [rel, content] of under('targets/claude/hooks/')) {
      add({ path: `.claude/hooks/${rel}`, content: render(content), managed: true })
    }
    addCanonical('.claude')
  }

  if (components.includes('agents')) {
    add({
      path: 'AGENTS.md',
      content: entryDoc('targets/agents/workflow.md', canonicalDirs('.agents').rules),
      managed: false,
    })
    addCanonical('.agents')
  }

  // Cursor and Copilot load path-scoped rules natively. Generated files carry a
  // `guren-` prefix so ownership stays unambiguous beside user-authored rules.
  const nativeRuleDocs: Array<[stem: string, doc: RuleDoc]> =
    components.includes('cursor') || components.includes('copilot')
      ? under('core/rules/').map(([rel, content]) => [
          rel.replace(/\.md$/u, ''),
          parseRuleDoc(rel, content),
        ])
      : []

  if (components.includes('cursor')) {
    for (const [stem, doc] of nativeRuleDocs) {
      add({
        path: nativeRulePath(CURSOR_RULES_NAMESPACE, stem),
        content: renderCursorRule(doc),
        managed: true,
      })
    }
    addMcpConfig('.cursor/mcp.json', 'targets/cursor/mcp.json')
  }
  if (components.includes('copilot')) {
    for (const [stem, doc] of nativeRuleDocs) {
      add({
        path: nativeRulePath(COPILOT_RULES_NAMESPACE, stem),
        content: renderCopilotRule(doc),
        managed: true,
      })
    }
    addMcpConfig('.vscode/mcp.json', 'targets/copilot/mcp.json')
  }

  if (components.includes('codex')) {
    addMcpConfig('.codex/config.toml', 'targets/codex/config.toml')
    // Starlark shell-approval rules, not instruction rules: Codex's analogue of
    // the .claude/settings.json allowlist. User-owned — sync never widens a policy.
    add({
      path: '.codex/rules/guren.rules',
      content: get('targets/codex/rules/guren.rules'),
      managed: false,
    })
  }
  if (components.includes('opencode')) {
    addMcpConfig('opencode.json', 'targets/opencode/opencode.json')
  }

  return [...planned.values()].sort((a, b) => a.path.localeCompare(b.path))
}
