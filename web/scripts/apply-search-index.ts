/**
 * Load this build's docs search index into D1, unless it is already there.
 * The gate is a budget: a reindex writes ~4,700 rows (FTS5 shadow tables
 * included) against D1's free tier of 100,000 a day, and the observed peak
 * deploy rate alone would exceed that. Sound because the build id hashes the
 * indexed content and nothing else (app/Services/search-index-build.ts). Runs
 * before `wrangler deploy`: a failure here stops the deploy and the old index
 * keeps serving; a deploy failing afterwards leaves the new tables unused.
 *   bun scripts/apply-search-index.ts [--local]   # --local rehearses against wrangler dev
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
