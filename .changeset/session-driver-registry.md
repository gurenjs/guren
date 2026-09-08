---
'@guren/server': minor
'@guren/cli': minor
---

Judge a session driver against what is installed, not against its name (RFC 0020 Part 4)

`BUILT_IN_SESSION_DRIVERS` names every driver the framework registers and
whether it survives a runtime that shares no memory between requests. A plugin
declares its own in `gurenPlugin.drivers.session`, which is data the CLI reads
from `node_modules` the way it reads `compatibility` — never executed.

The deploy-runtime check used to treat every driver that was not `memory` as
persistent, so it vouched for names nothing in the install stands behind: a
plugin driver whose package is absent, and a misspelled `datbase`, both passed
as backed. Those are now reported as unverified rather than as passing, which
is a new warning for an app whose driver is registered only in its own code.
Declaring it in a plugin manifest, or reading the warning as the reminder it
is, are both fine — the check never sets an exit code.
