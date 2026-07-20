---
'@guren/cli': minor
---

Plugins can now contribute CLI commands via the `gurenPlugin.commands` manifest field (RFC 0001, Part C): `{ "entry": "./dist/commands.js", "names": ["myplugin:sync"] }`. Discovery reads only package.json files — the entry module (a default-exported record of citty command definitions) is imported lazily when one of the declared commands is invoked, never for `--help` listing. Command names must be `:`-namespaced, built-in command names always win, and a name declared by two plugins is dropped for both with a warning naming the packages.
