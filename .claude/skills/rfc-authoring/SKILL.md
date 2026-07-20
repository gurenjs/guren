---
name: rfc-authoring
description: Draft an RFC for a significant change to the Guren framework itself, per contributing/rfc-process.md. Use when the user says "write an RFC", "create an RFC", "propose a breaking change", "RFC for X", or is about to design a new public API, cross-cutting feature, or major architecture decision for this monorepo.
---

# RFC Authoring Skill

You help Guren framework contributors draft RFCs that follow `contributing/rfc-process.md`. This is a maintainer/contributor-facing skill for changes to the **framework itself** — unrelated to Guren *application* plugins (see the `plugin-authoring` skill in the agent harness template for that).

## Step 1: Confirm an RFC Is Actually Required

Check the proposed change against `contributing/rfc-process.md`'s criteria before scaffolding anything:

**Required:**
- New public APIs or changes to existing public API signatures
- Breaking changes to any supported package
- Cross-cutting features that affect multiple packages
- Major architecture decisions (new dependencies, runtime requirements, build system changes)
- Changes to the release process or versioning strategy

**NOT required** (don't create an RFC for these — say so and proceed directly to implementation):
- Bug fixes, even complex ones
- Documentation improvements
- Internal refactors with no public API impact
- Minor additive features that don't change existing behavior
- Performance improvements with no API impact
- Test additions

If it's ambiguous, ask the user rather than guessing — an unnecessary RFC is friction, and a skipped required one bypasses the review the process exists for.

## Step 2: Find the Next RFC Number

```bash
ls rfcs/ | sort -V | tail -1
```

RFCs live in `rfcs/` at the **repository root**, named `NNNN-short-title.md` (4-digit, zero-padded). Use the next available number.

> **Do not confuse this with `.github/rfcs/`.** That directory holds a single, older, narrower "Breaking Change Process" RFC (`0001-rfc-process.md`, from the v1.0-alpha era) that predates and appears superseded by the general process in `contributing/rfc-process.md`. New RFCs of any kind — not just breaking changes — go in `rfcs/` at the root.

## Step 3: Draft Using the Required Template

```markdown
# RFC: <Title>

**Author:** <name or GitHub handle>
**Date:** <YYYY-MM-DD>
**Status:** Draft

## Problem

Describe the problem or limitation that motivates this change. Include
concrete examples of how users are affected today.

## Proposed Solution

Explain the design in enough detail that someone familiar with the
codebase can implement it. Include API examples, type signatures,
and configuration changes where relevant.

## Alternatives Considered

List other approaches you evaluated and explain why they were not
chosen. This helps reviewers understand the trade-offs.

## Migration Path

If this is a breaking change, describe how existing users upgrade:
- What code needs to change
- Can a codemod handle the migration automatically
- What is the deprecation timeline

## Open Questions

List unresolved design questions that need community input before
the RFC can be accepted.
```

Write the design section like a proposal someone else could implement — concrete function signatures, file paths, and worked examples beat prose description. Skip sections that don't apply (e.g. omit "Migration Path" detail for a purely additive change) rather than padding them.

## Step 4: Follow the Process

1. **Draft** — open a PR adding the file to `rfcs/` (or start a GitHub Discussion first for early-stage ideas).
2. **Discussion** — minimum two weeks; the author revises based on feedback.
3. **Decision** — the project maintainer accepts or rejects; update the `Status` field to record it. If the user driving this skill IS the deciding maintainer and wants to compress the discussion period for a solo/fast-moving change, that's their call to make explicitly — don't silently skip straight to `Status: Accepted` without flagging that the normal discussion window is being shortened.
4. **Implementation** — reference the RFC number in the implementation PR/commits (e.g. `Refs: RFC 0004`).

## Recording Deviations During Implementation

Designs shift once you're actually writing code. Rather than silently diverging from what the RFC says, amend the RFC document in place using a strikethrough + note, right where the outdated text was:

```markdown
Two plugins declaring the same name is ~~an error naming both packages~~
**Amended in implementation:** dropped for both with a warning naming
every declaring package — a hard error would break every invocation
over a third-party conflict.
```

This keeps the RFC as an accurate historical record of *why* the shipped behavior differs from the original proposal, without rewriting history. Do this whenever implementation reveals the original design was wrong, incomplete, or renamed (command names, flag names, file paths) — future readers comparing the RFC to the code should never hit an unexplained mismatch.
