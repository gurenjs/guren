---
"@guren/cli": patch
---

Undo the table-cell escaping in the docs viewer's renderer instead of splitting on it. `escapeMarkdownTableCell` doubles a backslash and then escapes every pipe, so a `screens.md` Props column holding a TypeScript union (`A \| B`) rendered as two cells with a stray backslash, pushing the rest of the row one column right. Row splitting now scans for unescaped pipes and reads `\\` as one unit, so a cell that ends in a backslash still lets the delimiter behind it split.
