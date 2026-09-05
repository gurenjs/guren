---
'@guren/cli': patch
---

`guren tool:log --surface durable` is now accepted

`durable` is the surface an agent an application hosts itself records under.
The flag previously refused it as a typo, which would have made a trail written
by that surface unreadable through this command.
