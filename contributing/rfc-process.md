# RFC Process

An RFC (Request for Comments) is a design document that proposes a significant change to Guren. It ensures that major decisions receive adequate review before implementation begins.

## When an RFC Is Required

- New public APIs or changes to existing public API signatures
- Breaking changes to any supported package
- Cross-cutting features that affect multiple packages
- Major architecture decisions (new dependencies, runtime requirements, build system changes)
- Changes to the release process or versioning strategy

## When an RFC Is NOT Required

- Bug fixes (even complex ones)
- Documentation improvements
- Internal refactors that do not affect the public API
- Minor features that add functionality without changing existing behavior
- Performance improvements with no API impact
- Test additions or improvements

## RFC Template

Use the following structure when drafting an RFC.

```markdown
# RFC: <Title>

**Author:** <your name or GitHub handle>
**Date:** <YYYY-MM-DD>
**Status:** Draft | Discussion | Accepted | Rejected | Withdrawn

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

## Process

### 1. Draft

Open a pull request to the `rfcs/` directory at the repository root with your RFC document named `NNNN-short-title.md`. Use the next available number. Alternatively, start a GitHub Discussion in the RFC category for early-stage ideas that are not yet ready for a formal proposal.

### 2. Discussion (minimum 2 weeks)

The RFC enters a discussion period of at least two weeks. During this time:

- Community members and maintainers review and comment on the PR or Discussion
- The author revises the RFC in response to feedback
- Substantive objections must be addressed before the RFC can advance

### 3. Decision

The project maintainer(s) make the final call on whether to accept or reject the RFC. The decision is recorded in the RFC document by updating its status field. Accepted RFCs are merged into the `rfcs/` directory.

### 4. Implementation

Once accepted, the RFC can be implemented. The implementation PR should reference the RFC number. The RFC author is not required to implement the proposal, but they are welcome to do so.

## Decision Authority

Project maintainer(s) have final decision authority on all RFCs. In cases of disagreement among maintainers, the lead maintainer breaks the tie. Decisions are based on:

- Alignment with project goals and philosophy
- Technical soundness
- Community feedback
- Maintenance burden
