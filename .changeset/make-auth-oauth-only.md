---
'@guren/cli': minor
---

`guren make:auth --oauth-only` scaffolds OAuth as an app's only sign-in method, completing RFC 0003 §4's passwordless requirement. `/login` becomes a provider-buttons page with no credential form and no `POST /login` route, and `LoginController` keeps only `show()` and `destroy()` (logout). Registration, password reset, `LoginValidator`, the login and profile password fields, and the demo `UsersSeeder` are all skipped — a seeded password could never be used to sign in, and hashing one is the per-request CPU cost the flag exists to avoid on metered runtimes like the Cloudflare Workers free tier.

`--oauth-only` requires `--oauth` with at least one supported provider (honouring it without providers would scaffold an app with no way in, and ignoring it would scaffold the password login the flag opts out of), subsumes `--minimal`, and skips `--verify` with a warning since provider-supplied emails arrive already vouched for. Scaffolding the password variants is unchanged, byte for byte.

Two consequences of removing the password surface are handled explicitly. The profile email is scaffolded read-only and dropped from `ProfileUpdateSchema`: with no verification flow in this mode, an editable email would let an account claim an address it never proved, and `OAuthController`'s collision check would then reject that address's real owner on their first sign-in. And because `make:auth` only ever writes the files it scaffolds, converting an existing password app with `--oauth-only --force` now reports the password files left on disk — notably `db/seeders/UsersSeeder.ts`, which `db:seed` finds without going through the route table.
