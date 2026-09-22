---
"@guren/cli": minor
---

Add `guren plan:close`, the end of the RFC 0030 loop. It refuses a plan whose
current hash nobody approved, and one with an element that is neither verified
nor waived, judged the way `plan:status` reports it. A closed plan leaves
`docs/plans/<slug>.md`, an OKF document naming the entities it touched, and a
draft block per section of each entity's `docs/entities/<Entity>.md`: purpose,
rules citing the acceptance ids that verify them, waivers, non-goals and a
history link. The blocks sit between `<!-- guren:plan … -->` markers, so a
second close rewrites only them, and nothing outside the markers is touched. The
plan file, its approvals and its decision log stay where they are. `--dry-run`
prints what would be written.

`guren docs:graph` now draws each acceptance id as a `test` node that
`verifies` the documents citing it as `(AC-comments-4)` and the entity its id
names, and the docs viewer shows them. `guren check --docs` warns on a citation
no test title carries, on a test id its entity's documents never cite, and on a
Rules item in an entity document that cites no id. The three are advisory, so
`check --ci` and `guren gate` do not fail on them.

`plan:status`, `plan:verify` and `plan:next` now name a plan kept as
`docs/plans/<slug>/plan.json` by its directory, so two plans in that layout no
longer share `.guren/plans/plan.state.json`. A state file left under the old
name is git-ignored and is simply not read again; the next `plan:verify`
rebuilds the records.
