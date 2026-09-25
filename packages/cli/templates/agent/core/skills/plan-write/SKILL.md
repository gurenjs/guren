---
name: plan-write
description: Write an implementation plan (`docs/plans/<slug>/plan.json`, RFC 0030) for a change before any code exists, in conversation with the person, check it with `plan:render`, and revise it from their review with `plan:revise`. Use when the user says "plan this feature", "write a plan", "design X before implementing it", "make a plan for", or asks for a change that spans several models, routes or pages. Not for building an approved plan (plan-implement) or for generating one CRUD entity (feature).
---

# Plan Writing Skill

You write the plan in this session, the person reviews and approves it, and
`plan-implement` builds it. Never run `plan:approve`: approving is the
person's decision, made after reading the page.

## 1. Get the prompt and follow it

```bash
bunx guren plan "<the request>" --print-prompt
```

Quote the request: an unquoted word starting with `-` is read as a flag.
Follow the prompt it prints. When it has you ask the person, ask in whatever
way your client offers and wait for the answers before you write the JSON. If
the change needs no plan, make it the usual way.

## 2. Check it until nothing fails

```bash
bunx guren plan:render docs/plans/<slug>/plan.json --json
```

Run it until no check has `"status": "fail"`, then tell the person:

- where the page is (`path` in the output), which is what they review
- the questions still open, each with the option the plan assumes
- the warnings you left, and why

## 3. Revise

Before the first review, edit `plan.json` directly. After a review, apply the
person's changes and the page's exported feedback to a copy of the plan,
leaving `baseline` as it is, and record them:

```bash
bunx guren plan:revise docs/plans/<slug>/plan.json \
  --edited <copy> --message "<what changed and why>" --feedback -
```

- Keep the copy, and any saved `feedback.json`, outside the repository:
  `plan:approve` and `plan:next` count every untracked file under the app root
  as uncommitted work.
- `--feedback -` reads the feedback the person pastes from standard input.
- An element the feedback approved is locked unless `--reopens "<why>"` says
  why it changes.
- Feedback applies to the page it came from: render again after every change,
  report as in step 2, and have the person review the new page.
- After approval, the plan changes only through `plan:revise`, and the person
  approves it again.

## 4. Hand off

The person approves the plan with:

```bash
bunx guren plan:approve docs/plans/<slug>/plan.json
```

It stamps the plan against a clean working tree. Once they have approved it
and committed the plan with its `approvals.json` and `revisions/`, the
`plan-implement` skill builds it step by step.
