---
'@guren/orm': patch
---

The seeder loader skips dot files in `db/seeders/`. macOS writes a `._<name>.ts` AppleDouble file beside each file copied to a non-HFS volume or packed into an archive, and importing one failed the whole seed run with a syntax error.
