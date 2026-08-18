# Contributing

This repository is **generated**. Nothing here is edited by hand.

Its contents are rendered by `scripts/build-agent-catalog.ts` in
[gurenjs/guren](https://github.com/gurenjs/guren) from the sources under
`packages/cli/templates/agent-catalog/`, checked by that repository's CI, and
published here on each Guren release. A pull request against this repository
would be reverted by the next publish.

To change a skill, a manifest, or this README, open a pull request against
`gurenjs/guren` that edits the corresponding file under
`packages/cli/templates/agent-catalog/`. The CI gate there
(`audit:agent-catalog`) verifies that every `guren` command and flag the
skills name is one the CLI actually registers, and that the manifests
validate.
