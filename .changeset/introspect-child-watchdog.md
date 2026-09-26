---
'@guren/cli': patch
---

The introspection child now ends itself when the CLI that started it is gone, and two seconds past the CLI's introspection timeout. An app that computed synchronously without yielding starved the child's stdin watch, so a child whose CLI had died kept spinning at full CPU until killed by hand.
