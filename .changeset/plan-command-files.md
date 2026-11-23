---
'@guren/cli': minor
---

`guren change:lane` lowers to `low` an added file that a `make:*` command of an approved, open plan writes (RFC 0040 §3), for the generators that write one file: `make:model`, `make:controller`, `make:resource`, `make:validator`, `make:policy`, `make:provider`, `make:middleware`, `make:route`, `make:factory`, `make:channel` and the side-effect generators. The command is read as the plan check reads it, and the file is held to what the generator writes for its name, flags and `--module`. Where an element the plan adds in that module owns the file's class, that element's check applies instead, as for a file `plan:scaffold` writes. A provider and a routes file are always held to the generator's output. A flag the generator does not take, a path the scaffold or a second command also writes, and a path a second open plan claims declare nothing. What blueprints, `make:auth` and `make:feature` write stays `medium`.
