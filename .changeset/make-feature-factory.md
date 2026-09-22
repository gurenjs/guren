---
'@guren/cli': minor
---

`guren make:feature --factory` writes a model factory in `db/factories` beside the model, the same file `make:factory` generates. The `withFactory` option of `makeFeature()` was declared but never read, so passing it changed nothing; it now writes the factory.
