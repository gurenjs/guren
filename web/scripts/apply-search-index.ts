/**
 * Load this build's docs search index into D1, unless it is already there.
 *
 * The gate is not an optimisation. Every reindex writes ~4,700 rows counting
 * FTS5's shadow tables, and D1's free tier allows 100,000 written rows a day;
 * at the observed peak deploy rate, reindexing unconditionally would exceed
 * that on its own. Deploys that do not touch `docs/` — the large majority —
 * must cost nothing here.
 *
 * The comparison is sound because the build id is a hash of the indexed
 * content and of nothing else (see app/Services/search-index-build.ts). If a
 * clock or a commit sha could move it, this would reindex every time; if
 * something outside the corpus could hold it *still*, the deploy would name
 * tables nobody created.
 *
 * Runs before `wrangler deploy`, which is the moment the new table names go
 * live. If this step fails the deploy does not happen and the old index keeps
 * serving; if it succeeds and the deploy then fails, the new tables sit
 * unused until the next one, which is the harmless direction.
 *
 *   bun scripts/apply-search-index.ts            # remote (deploy)
 *   bun scripts/apply-search-index.ts --local    # rehearse against wrangler dev
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { searchIndexBuild } from '../.guren/search-index.gen.js'

import { createD1Client, isRemote } from './d1.js'

const sqlPath = resolve(fileURLToPath(new URL('..', import.meta.url)), '.guren/search-index.sql')

interface StateRow {
  build_id: string
}

if (!searchIndexBuild.indexed) {
  throw new Error(
    'No search index was built. Run `bun run --cwd web cloudflare:build` first — ' +
      'a stub generated module means the deployed Worker would answer 503 to every search.',
  )
}

const d1 = createD1Client(isRemote(process.argv))

// No row is the first deploy: nothing to compare against, everything to write.
const [state] = await d1.query<StateRow>('SELECT build_id FROM search_index_state WHERE id = 1')

if (state?.build_id === searchIndexBuild.buildId) {
  console.log(`Search index ${searchIndexBuild.buildId} is already in ${d1.label} — skipping.`)
} else {
  const from = state?.build_id ?? 'nothing'
  console.log(`Loading search index ${searchIndexBuild.buildId} into ${d1.label} (was ${from}).`)
  await d1.executeFile(sqlPath)

  const [applied] = await d1.query<StateRow>('SELECT build_id FROM search_index_state WHERE id = 1')
  if (applied?.build_id !== searchIndexBuild.buildId) {
    throw new Error(
      `The index SQL ran but ${d1.label} still reports build ${applied?.build_id ?? 'none'}.`,
    )
  }
  console.log('Loaded.')
}
