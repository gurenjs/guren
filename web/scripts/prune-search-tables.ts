/**
 * Drop the search tables no build can still be asked for.
 *
 * Runs *after* a successful deploy, and keeps two: the build just deployed and
 * the one it replaced. Both halves of that matter.
 *
 * After, because the state row records what has been *loaded*, not what is
 * live — the index goes in before `wrangler deploy`. A deploy that fails at
 * that last step leaves the row ahead of the Worker, and a prune trusting it
 * would delete the tables the live Worker is still naming. Running only on
 * the success path means the row and the Worker agree by the time this reads
 * it.
 *
 * Two, because `wrangler rollback` activates an earlier Worker version and
 * does not roll D1 back with it. The previous build's tables have to still be
 * there for the Worker that names them. Rolling back more than one docs
 * change is not covered; a redeploy is the way out of that.
 *
 * Dropping at the head of the index SQL instead would be the same mistake one
 * step earlier: a failed deploy leaving the live Worker naming tables the SQL
 * had already removed.
 *
 *   bun scripts/prune-search-tables.ts            # remote (deploy)
 *   bun scripts/prune-search-tables.ts --local    # rehearse against wrangler dev
 */
import { createD1Client, isRemote } from './d1.js'

interface StateRow {
  build_id: string
  previous_build_id: string | null
}

interface TableRow {
  name: string
}

const d1 = createD1Client(isRemote(process.argv))

const [state] = await d1.query<StateRow>(
  'SELECT build_id, previous_build_id FROM search_index_state WHERE id = 1',
)
if (!state?.build_id) {
  console.log(`${d1.label} records no search index — nothing to prune.`)
  process.exit(0)
}

const keep = [state.build_id, state.previous_build_id].filter(
  (id): id is string => typeof id === 'string' && id.length > 0,
)
const keepList = keep.map((id) => `'${id}'`).join(', ')

/**
 * `sql LIKE 'CREATE VIRTUAL TABLE%'` picks the FTS5 table itself and skips the
 * shadow tables it owns (`…_data`, `…_idx`, `…_docsize`, `…_config`), which
 * share its name as a prefix. Dropping the virtual table takes those with it;
 * dropping one of them directly would corrupt an index still in use.
 */
const stale = await d1.query<TableRow>(
  `SELECT name FROM sqlite_master
   WHERE type = 'table'
     AND replace(replace(name, 'doc_sections_', ''), 'doc_search_', '') NOT IN (${keepList})
     AND (
       name GLOB 'doc_sections_*'
       OR (name GLOB 'doc_search_*' AND sql LIKE 'CREATE VIRTUAL TABLE%')
     )`,
)

if (stale.length === 0) {
  console.log(`${d1.label} holds only ${keep.join(' and ')} — nothing to prune.`)
  process.exit(0)
}

// One statement: D1 has no transactions, and a half-finished prune is only
// ever extra tables, but there is no reason to make several round trips.
const drops = stale.map((table) => `DROP TABLE IF EXISTS "${table.name}";`).join(' ')
await d1.query(drops)

console.log(
  `Retired ${stale.length} table(s) from ${d1.label}, keeping ${keep.join(' and ')}: ` +
    stale.map((table) => table.name).join(', '),
)
