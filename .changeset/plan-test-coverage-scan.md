---
'@guren/cli': minor
---

`guren plan:render` lists, under a changed route, action or model, the `TestApp` requests in the existing tests that reach its routes (RFC 0030 §2). The requests are read statically from each test file and matched against the route graph. A request whose path is built at runtime, or made on what an imported helper returns, is named instead of guessed. An altered or dropped route that no `TestApp` request reaches gets a note saying so. Tests named after the model or the route's controller are listed beside them, labelled as matched by file name.
