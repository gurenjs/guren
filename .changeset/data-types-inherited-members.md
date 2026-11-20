---
'@guren/cli': patch
---

`guren codegen` no longer emits a `Data` type that leaves out inherited members. A payload interface extending another type (`interface PostResourceData extends Base`) was copied with its own members only, so the frontend type compiled and understated the response. It is now emitted as a reference to the declaration when the file exports it. When it does not, the copy stays and codegen warns that it holds none of the inherited members. An interface extending only `Record<string, unknown>`, as `make:resource` writes it, is copied as before.
