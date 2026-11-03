---
name: plan-write
description: "Write and revise an implementation plan (`docs/plans/<slug>/plan.json`, RFC 0030) before any code, for a change across several models, routes or pages (\"plan this feature\"). Its step 0 comes first, headless and scheduled runs included: it decides whether a plan is written when nobody in the session can approve one."
---

# Plan Writing Skill

You write the plan in this session, the person reviews and approves it, and
`plan-implement` builds it. Never run `plan:approve`: approving is the
person's decision, made after reading the page.

## 0. Check that someone will approve it

A plan is built only after a person approves it, so decide this before you
run anything below. Nobody will approve one in this session when:

- the request says nobody will review or approve it, or that the work runs
  unattended (overnight, on a schedule, "don't wait for me"), or
- the session cannot reach the person: a non-interactive run such as
  `claude -p`, a CI job or a scheduled task, where no reply can come.

Then, when the request asks for the plan itself, for a person to review
later, write it, stop after step 2, and implement nothing. When the request is
for the working change and no plan for it exists, write no plan and no
`docs/plans/` file: build it directly with the ordinary workflow (the
`feature` or `scaffold` skill, `bunx guren check` after each edit, and
`bunx guren gate` until it exits 0). An unapproved plan never reaches
`plan:next`, so writing one spends the tokens and builds nothing. When the
request names a plan that is not approved, the `plan-implement` skill
reports it and stops. When you cannot tell and can ask the person, ask once.

## 1. Get the prompt and follow it

```bash
bunx guren plan "<the request>" --print-prompt
```

Quote the request: an unquoted word starting with `-` is read as a flag.
Follow the prompt it prints. When it has you ask the person, ask in whatever
way your client offers and wait for the answers before you write the JSON. If
the change needs no plan, make it the usual way.

A schema error on a reference field (a regex mismatch) means it holds a name
or path where the prompt's "Ids and changes" rules ask for an element id.

## 2. Check it until nothing fails

```bash
bunx guren plan:render docs/plans/<slug>/plan.json --json
```

Run it until no check has `"status": "fail"`, then tell the person:

- with the dev server running (`GUREN_MCP=1`), `/_guren/plans/<slug>`, where
  the plan waits for their approval beside the other open plans; **Review this
  plan** there opens the page and saves their review as they make it
- without the server, where the page is (`path` in the output), which they
  review from disk and export by hand
- the questions still open, each with the option the plan assumes
- the warnings you left, and why

## 3. Revise

Before the first review, edit `plan.json` directly. After a review, apply the
person's changes to a copy of the plan, leaving `baseline` as it is, and record
them. When they reviewed in the Dev Center, the review is in
`.guren/plans/<slug>.feedback.json`: read its comments and answers from there,
and `plan:revise` applies its approvals and answers on its own:

```bash
bunx guren plan:revise docs/plans/<slug>/plan.json \
  --edited <copy> --message "<what changed and why>"
```

It says which file it applied, and warns instead when the review was given on
an earlier version of the plan: render again and ask for a new review. When
they pasted the page's feedback instead, pass it in:

```bash
bunx guren plan:revise docs/plans/<slug>/plan.json \
  --edited <copy> --message "<what changed and why>" --feedback - <<'EOF'
<the feedback JSON the person pasted>
EOF
```

- Keep the copy, and any saved `feedback.json`, outside the repository:
  `plan:approve` and `plan:next` count every untracked file under the app root
  as uncommitted work.
- `--feedback -` reads standard input, so feed the pasted JSON in with a
  heredoc as above: your shell is not a terminal the person types into, and a
  bare `-` waits for input that never comes.
- Apply each answer (the option picked, and any text written) to the elements
  its `affects` names, then remove the question from the copy; `plan:revise`
  refuses a copy that keeps an answered question.
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
