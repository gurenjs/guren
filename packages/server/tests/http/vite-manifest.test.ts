import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientManifestCandidates,
  loadViteManifest,
  getManifestFile,
} from '../../src/http/vite-manifest'
// The deploy plugins locate the same manifest through core's build-time
// helpers, and the preference order lives on both sides: here as
// `clientManifestCandidates`, there as `manifestPaths` in
// `packages/core/src/internal/deploy-build.ts`. The rule cannot be shared as
// code — core depends on server, and deploy-build deliberately imports
// nothing beyond node builtins — so this test is the coupling: it drives both
// lookups against one fixture and fails if the orders ever disagree again.
// Importing the module here is safe for the same reason it is portable: its
// own test pins that the built artifact imports node builtins only.
import { resolveClientAssetEnv } from '../../../core/src/internal/deploy-build'

const ENTRY = 'resources/js/app.tsx'

describe('clientManifestCandidates', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'guren-vite-manifest-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * Both layouts at once, with different content on purpose: the flat file
   * plays the stale leftover an older Vite config wrote before the app moved
   * to the `.vite/` layout Vite >= 5 uses.
   */
  function writeBothLayouts(): void {
    const assets = join(root, 'public/assets')
    mkdirSync(join(assets, '.vite'), { recursive: true })
    writeFileSync(
      join(assets, 'manifest.json'),
      JSON.stringify({ [ENTRY]: { file: 'app-Stale00.js' } }),
    )
    writeFileSync(
      join(assets, '.vite/manifest.json'),
      JSON.stringify({ [ENTRY]: { file: 'app-Fresh00.js' } }),
    )
  }

  test('should prefer .vite/manifest.json over a stale flat manifest.json', () => {
    writeBothLayouts()

    const manifest = loadViteManifest(clientManifestCandidates(root), 'client', {
      warnOnMissing: false,
    })

    expect(manifest?.__path__).toBe(join(root, 'public/assets/.vite/manifest.json'))
    expect(getManifestFile(manifest?.[ENTRY])).toBe('app-Fresh00.js')
  })

  test('should fall back to the flat manifest.json when .vite/ is absent', () => {
    mkdirSync(join(root, 'public/assets'), { recursive: true })
    writeFileSync(
      join(root, 'public/assets/manifest.json'),
      JSON.stringify({ [ENTRY]: { file: 'app-Flat00.js' } }),
    )

    const manifest = loadViteManifest(clientManifestCandidates(root), 'client', {
      warnOnMissing: false,
    })

    expect(manifest?.__path__).toBe(join(root, 'public/assets/manifest.json'))
    expect(getManifestFile(manifest?.[ENTRY])).toBe('app-Flat00.js')
  })

  test('should agree with the deploy-plugin lookup on which layout wins', () => {
    writeBothLayouts()

    const runtime = loadViteManifest(clientManifestCandidates(root), 'client', {
      warnOnMissing: false,
    })
    const deploy = resolveClientAssetEnv(join(root, 'public'), ENTRY, 'Test build')

    // The same hashed file, addressed by each side's own URL convention. A
    // disagreement here means an app carrying both layouts serves one asset
    // version locally and another after a serverless deploy.
    expect(getManifestFile(runtime?.[ENTRY])).toBe('app-Fresh00.js')
    expect(deploy.entry).toBe('/assets/app-Fresh00.js')
  })
})
