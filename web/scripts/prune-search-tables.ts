/**
 * Drop the search tables no build is using any more.
 *
 * Runs at the *start* of a deploy, not the end, and keeps whichever build id
 * D1 currently records — which is the one the Worker now serving the site was
 * deployed with. So after each deploy two builds exist, and the older one is
 * only retired by the deploy after that. That one-build lag is the point:
 * `wrangler rollback` puts the previous Worker back, and it names the
 * previous tables. Pruning at the end of a deploy would leave that rollback
 * querying tables that no longer exist.
 *
 * Doing this rather than dropping at the head of the index SQL is the same
 * argument one step earlier: a failed deploy would otherwise leave the live
 * Worker naming tables the SQL had already removed.
 *
 *   bun scripts/prune-search-tables.ts            # remote (deploy)
 *   bun scripts/prune-search-tables.ts --local    # rehearse against wrangler dev
 */
import { createD1Client, isRemote } from './d1.js'

interface StateRow {
  build_id: string
}

interface TableRow {
  name: string
}

const d1 = createD1Client(isRemote(process.argv))

const [state] = await d1.query<StateRow>('SELECT build_id FROM search_index_state WHERE id = 1')
if (!state?.build_id) {
  console.log(`${d1.label} records no search index — nothing to prune.`)
  process.exit(0)
}

/**
 * `sql LIKE 'CREATE VIRTUAL TABLE%'` picks the FTS5 table itself and skips the
 * shadow tables it owns (`…_data`, `…_idx`, `…_docsize`, `…_config`), which
 * share its name as a prefix. Dropping the virtual table takes those with it;
 * dropping one of them directly would corrupt an index still in use.
 */
const stale = await d1.query<TableRow>(
  `SELECT name FROM sqlite_master
   WHERE type = 'table'
     AND name <> 'doc_sections_${state.build_id}'
     AND name <> 'doc_search_${state.build_id}'
     AND (
       name GLOB 'doc_sections_*'
       OR (name GLOB 'doc_search_*' AND sql LIKE 'CREATE VIRTUAL TABLE%')
     )`,
)

if (stale.length === 0) {
  console.log(`${d1.label} holds only build ${state.build_id} — nothing to prune.`)
  process.exit(0)
}

// One statement: D1 has no transactions, and a half-finished prune is only
// ever extra tables, but there is no reason to make several round trips.
const drops = stale.map((table) => `DROP TABLE IF EXISTS "${table.name}";`).join(' ')
await d1.query(drops)

console.log(
  `Retired ${stale.length} table(s) from ${d1.label}, keeping build ${state.build_id}: ` +
    stale.map((table) => table.name).join(', '),
)
