---
'@guren/cli': patch
---

The plan page `guren plan:render` writes is now built from TypeScript modules typed against the plan schema, bundled into the same single self-contained file. The page refuses a plan whose `planVersion` it was not built for and says so, instead of drawing the fields it happens to understand.
