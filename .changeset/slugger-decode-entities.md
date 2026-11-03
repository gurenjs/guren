---
'@guren/plugin-markdown': patch
---

Heading ids no longer spell out HTML entities. A heading with an apostrophe, an ampersand or quotes now slugs from its text, so `## The audit's policy rule` gets `id="the-audits-policy-rule"` (GitHub's id) rather than `the-audit39s-policy-rule`, and `## Inspection & Audit Commands` gets `inspection-audit-commands` rather than `inspection-amp-audit-commands`. Links written against the old ids need updating.
