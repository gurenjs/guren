// The one `guren` oxlint plugin, published as `@guren/cli/oxlint` and loaded by this
// repo's own .oxlintrc.json straight from src (oxlint's plugin host needs no build).
// Every rule sits under one name: oxlint registers a plugin name once, so two
// plugin files cannot both be `guren`.
import asyncAssertion from './await-async-assertion.js'
import { rules as commentRules } from './comments.js'
import { rules as envRules } from './nullish-env-default.js'

export default { meta: { name: 'guren' }, rules: { ...asyncAssertion.rules, ...commentRules, ...envRules } }
