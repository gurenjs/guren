// The one `guren` plugin oxlint loads: every repo-local rule under one name,
// since oxlint registers plugin names once and two files cannot both be `guren`.
import asyncAssertion from './await-async-assertion.js'
import { rules as commentRules } from './comments.js'

export default { meta: { name: 'guren' }, rules: { ...asyncAssertion.rules, ...commentRules } }
