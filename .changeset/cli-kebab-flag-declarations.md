---
'@guren/cli': patch
---

Declare nine CLI flags with the kebab-case spelling the docs already use, so
`--help` and the docs agree and the documented spelling parses natively.

`db:migrate`, `db:seed`, `db:reset`, `db:fresh`, `queue:flush`, `upgrade`,
`agent:init` and `agent:sync` declared `dryRun`, and `upgrade` declared
`checkOnly`. citty registers only the *declared* arg name, so `renderUsage`
advertised `-d, --dryRun` and `--checkOnly` while every guide documents
`--dry-run` and `--check-only` — and the documented spelling reached the
command as the truthy string `"false"` rather than a parsed boolean. They are
now declared `'dry-run'` and `'check-only'`, matching how `token:issue` already
declares `'read-only'` and `'allow-unmatched'`.

No flag is removed: the camelCase spellings still resolve through citty's
proxy, and the `-d` alias is unchanged. Aliases are deliberately not used for
this — `renderUsage` renders an alias single-dashed, so `alias: 'dry-run'` would
print `-dry-run, --dryRun`.

One user-visible behaviour changes for the better. Mixing two spellings of one
flag resolves to the declared name rather than to the last one typed, so
`--dryRun=false --dry-run=true` previously ran a real `db:reset` although the
user's last word asked for a dry run; the declared name is now the documented
one, so that invocation dry-runs. The reverse mix is still won by whichever
spelling is declared, not by argument order.

`upgrade --no-autofix` is untouched and already correct: it is declared as the
positive `autofix` arg, because citty's `--no-` branch claims `--no-autofix`
and writes the key `autofix` whatever the arg is called. A `'no-autofix'`
declaration would advertise a flag that is still ignored, so that flag is not
part of this rename.
