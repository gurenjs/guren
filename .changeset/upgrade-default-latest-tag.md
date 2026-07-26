---
"@guren/cli": patch
---

fix: `guren upgrade` defaults to the `latest` dist-tag and refuses to downgrade silently

The default was `rc`, a tag still pointing at the pre-1.0 release candidates it
was cut for. Running `guren upgrade` with no arguments on a released app
rewrote every `@guren/*` pin backwards across the 1.0 boundary — and reported
it as `✔ Version compatible (1.0.0 -> rc)`, because the compatibility line
printed the tag name instead of the version it resolves to. The runtime warning
for duplicate `@guren/orm` copies names this command as its remedy, so the path
most likely to be taken by someone fixing a version mismatch was the one that
introduced a bigger one.

Three changes:

- The default tag is now `latest`, exported as `DEFAULT_UPGRADE_TAG` so the CLI
  flag description, the programmatic default, and `upgradeCanary()` cannot drift
  apart. `--tag rc` and `--canary` still work.
- `versionCompatibility.targetVersion` now carries the version the tag resolved
  to, and a new `downgrade` field is set when that version is older than what
  the app already pins. The CLI prints it as a warning under a `Downgrade`
  heading rather than a success line. An explicit `--tag` is still honoured —
  the point is that it is no longer silent. For any tag other than `canary`,
  codemods now receive that resolved version instead of the tag string, which no
  codemod range could ever match; `--canary` keeps pinning the floating tag, so
  it still passes the literal `canary` through.
- `compareVersions` handles prereleases. `'1.0.0-rc.4'.split('.')` yielded
  `[1, 0, NaN, 4]`, and a NaN difference is neither greater nor less than zero,
  so every comparison against a `1.0.0-rc.N` version answered "unordered" —
  which reads as "equal" to callers testing for `< 0`. Guren shipped its whole
  1.0 line in that shape, so this covered exactly the versions the upgrade path
  compares. A release now outranks its own prereleases, prerelease identifiers
  order numerically rather than lexically, and non-version specifiers such as
  `workspace:*` return NaN so callers can skip them.
