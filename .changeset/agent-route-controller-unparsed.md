---
'@guren/cli': patch
---

`guren check` warns `agent-route-controller-unparsed:<file>` on a controller file that does not parse. Such a file declares no class to the controller scan, so an agent route whose action lives there was judged against no body, and a same-named class in another file was read in its place with no collision reported.
