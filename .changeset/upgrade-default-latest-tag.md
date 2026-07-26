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
- A registry lookup that throws now degrades to "could not resolve" instead of
  taking the command down. The lookup is memoized, and one caller wraps it in
  `.catch` while the other does not, so a cached rejection was handled once and
  rethrown the second time — an unreachable registry aborted the whole upgrade.
  An unresolved tag is also no longer reported as compatible, and codemods are
  skipped for it, since a tag name matches no codemod range.
- `compareVersions` handles prereleases. `'1.0.0-rc.4'.split('.')` yielded
  `[1, 0, NaN, 4]`, and a NaN difference is neither greater nor less than zero,
  so every comparison against a `1.0.0-rc.N` version answered "unordered" —
  which reads as "equal" to callers testing for `< 0`. Guren shipped its whole
  1.0 line in that shape, so this covered exactly the versions the upgrade path
  compares. It now delegates to `Bun.semver.order`, the comparator this package
  already uses for plugin compatibility ranges, behind a guard that returns NaN
  for anything that is not one exact version — including a partial pin like
  `1.3`, which `Bun.semver` ranks *above* `1.3.0`. `guren doctor` had a private
  copy of the old implementation for its Bun version floor, so a Bun prerelease
  such as `1.1.1-canary.3` was reported as below the minimum; it now shares the
  fixed one.

`guren upgrade --check-only` needs the network now, since resolving the tag is
what the check reports. Version lookups read the registry's `dist-tags`
endpoint instead of the full packument (61 B rather than ~33 KB per package,
which grew with every release), and every package resolves concurrently, so an
unreachable registry costs one connect timeout rather than one per package.

The downgrade check anchors on the first comparable `@guren/*` pin. Tags can
resolve per-package, so this is a safety net over the common case of one release
line across every entry rather than a guarantee for each individual rewrite.
