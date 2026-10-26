---
'@guren/cli': patch
---

`guren make:auth` now scaffolds a profile update that asks for the current password before it changes the account's email or password, so a stolen or unattended session can no longer replace both and lock the owner out. `ProfileUpdateSchema` gains a `currentPassword` field, the profile page a "Current password" input, and `ProfileController.update()` checks it through `auth.guard().validate()` before the email conflict lookup. A save that changes only the name needs no password, including when the stored address differs from the submitted one only in case. An account with no password hash (created through OAuth) can no longer set a password or change its email from the profile page. `--oauth-only` output is unchanged, and apps scaffolded earlier are not modified.
