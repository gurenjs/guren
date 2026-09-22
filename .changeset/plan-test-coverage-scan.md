---
'@guren/cli': minor
---

`guren plan:render` lists, under a changed route, action or model, the tests whose `TestApp` requests reach its routes (RFC 0030 §2). The requests are read statically from each test file, matched against the route graph, and a request whose path is built at runtime is named instead of guessed. An altered or dropped route that no test request reaches gets a note saying so. Tests matched by file name stay, labelled as such.
