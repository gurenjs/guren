---
'@guren/cli': patch
---

`guren browser:map` writes the acceptance ids in a new feature file's charters as code (`` `AC-posts-store-1` ``), so `guren check --docs` no longer reads them as citations and warns that no test carries them. A feature file written before keeps its charters, which are yours to edit: wrap the ids in backticks to clear the warnings.
