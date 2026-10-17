# Review

What a review of this repository reports, and what counts as a failure here.
The `code-review` agent reads this first; the rules behind each line live in
`.claude/rules/` and `CLAUDE.md`, and this file only says what to look for.

## A finding

Each finding names:

- `file:line`, read in the code, never inferred from a name or a file listing
- the trigger: the input, state or environment that reaches the defect
- the consequence: the wrong output, the crash, the check that passes when it
  should fail

A suspicion the reviewer could not confirm is reported as one, with what would
confirm it. Tag every finding:

- **Important**: this change causes, or fails to prevent, the consequence
- **Nit**: correct but worth changing; at most three per review, none on a
  re-review
- **Pre-existing**: the defect is on the base branch too; reported, never
  blocking, never charged to this change

When a finding is one instance of a pattern, name the pattern, search for the
other instances, and list them, so the author fixes the class in one round.

The summary opens with the count (`2 Important, 1 Nit, 0 Pre-existing`) and
says `Nothing to fix.` when that is the result. No strengths section.

## What failure looks like here

- **Checks, scanners, audits** (`packages/cli/src/*-check.ts`, `audit.ts`,
  `plan/`): fail-open. Something the reader could not read, import or resolve
  is reported as a pass or as absent instead of `unknown` / unverifiable. An
  exception list where an allowlist belongs. A rule restated in a second module
  beside the "one rule for …" file `CLAUDE.md` names, so the two can disagree.
  A check that only ever reports is not a defect; one that claims success it
  did not observe is.
- **Guards and security boundaries** (CSRF exemptions, loopback and MCP guards,
  auth, env-gated endpoints): a missing signal (no peer, no `Origin`, no env)
  treated as allow. `process.env?.NODE_ENV` in a gate a bundler `--define`
  settles. New attack surface that is on by default.
- **Templates** (`packages/create-app/templates/`, `packages/cli/templates/`):
  output that breaks against the `@guren/*` an app installs from npm, as
  opposed to the workspace. Using an API added in the same PR is allowed and
  leaves `smoke:starter:npm` red until the release; say so rather than flag it.
  Scaffold contents the starter audits assert literally.
- **Published packages**: a name removed or renamed that a published dependent
  imports; a server major without a core major; a bundle setting that renames
  a class whose name is stored (jobs, notifications, models).
- **Tests**: a test that cannot fail (a mocked driver, an assertion on the
  fixture), or one that calls the fixed function directly when the defect was
  in how it is reached.
- **CI and smoke scripts**: `bunx guren`; addressing the port asked for rather
  than the one the app reports; a body assertion with no status check.
- **Docs**: a statement the code contradicts, a symbol or command that does not
  exist, `@guren/server` in user-facing text. Prose style is `audit:prose` and
  `.claude/rules/prose.md`, not a finding unless it misleads.

## Skip

Generated files are judged by the command that writes them, not read by hand:
`.guren/*.gen.ts`, `docs/spec/` views, `dist/`, `bun.lock`. What `bun run lint`
reports (the `guren/comment-*` rules, unused variables and imports, floating
promises, a bare `expect().rejects`) is a finding only when lint is red.
Nothing in the repository checks formatting, and it is not a finding.
