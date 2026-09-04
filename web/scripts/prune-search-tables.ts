/**
 * Drop the search tables no build can still be asked for. Runs after a
 * successful deploy and keeps two builds: the one just deployed and the one it
 * replaced. After, because the state row records what is loaded, not what is
 * live (the index goes in before `wrangler deploy`), so a prune before the
 * deploy succeeds could drop tables the live Worker still names. Two, because
 * `wrangler rollback` activates an earlier Worker without rolling D1 back;
 * rolling back more than one docs change is not covered (redeploy instead).
 *   bun scripts/prune-search-tables.ts [--local]   # --local rehearses against wrangler dev
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
