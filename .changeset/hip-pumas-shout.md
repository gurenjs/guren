---
"@guren/cli": patch
---

Promotion now leaves `Data.<Entity>` in `data.gen.ts`. The Resource `make:feature` writes when promoting a prototype feature annotated `toArray()` with the `<Entity>Data` it imports from `resources/js/types/`, and codegen reads only the Resource's own source, so it warned and omitted the type. The annotation now names the `<Entity>ResourceData` alias the same file declares.
