---
'@guren/cli': patch
---

Tighten the `issues:` reference grammar and make `--issue` comma-separated

A URL reference may no longer contain whitespace, quotes, commas or
backslashes: the characters that would break the `--issue` list, the quoted
YAML scalar `make:adr` writes, or the scanner's split of an unquoted
inline-list entry. Rejecting them in the grammar keeps every consumer safe by
construction; `guren check --docs` reports such an entry as unreadable, as it
does any other malformed one. Issue numbers must be positive safe integers.

`make:adr --issue` takes a comma-separated list. Repeating the flag keeps only
the last value, like every other flag of this CLI, and the help text no longer
claims otherwise.

`guren context <Entity>` orders Linked issues by repository then number, with
URL entries last, so the order no longer depends on whether the `origin`
remote resolved.
