---
"@guren/cli": minor
---

`guren plan:render` now runs the RFC 0030 §2 checks it renders. The command reads
the application state through the scanners the other commands use, validates the
plan against it, and hands the results to the page, so the pinned "needs
attention" block and the per-element check rows carry real findings instead of
being empty. A failing check never stops the render: the page is where someone
reads what is wrong with the plan. A section the scanners could not read (an app
with no `db/schema.ts`, an unreadable routes file) still renders, carrying the
warning that says so.

`--app <dir>` names the application root the checks are read from, spelled as
`spec:generate` and `docs:graph` spell it. The plan file itself stays resolved
against the working directory: `--app` is the application, and a plan may be
reviewed from wherever it was written.

The command's own duplicate-id warning is gone. The same rule is one of the §2
checks, which reports it beside the element on the page, so the finding now has
one spelling rather than two.

The page's feedback document has a reader for the revise command a later release
adds; nothing calls it yet. It takes a file or standard input, and at most 5 MiB,
counted as the document arrives, which is far above a feedback document and low
enough to stop a log or a binary piped in by mistake.
