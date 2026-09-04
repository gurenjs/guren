import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { upgradeCanary } from '../../packages/cli/src/upgrade'
import { assertLocalGurenDependencies, collectLocalPackages } from './local-packages'

const repoRoot = resolve(import.meta.dir, '../..')
const appFixture = resolve(repoRoot, 'examples/blog')
const tempRootBase = resolve(repoRoot, '.upgrade-existing-smoke-')
const FIXTURE_VERSION = '9.9.9'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function run(cmd: string[], cwd: string): Promise<void> {
  console.log(`\n$ (${cwd}) ${cmd.join(' ')}`)
  const proc = Bun.spawn({
    cmd,
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(' ')}`)
  }
}

async function rewriteManifestToLocalFiles(appDir: string): Promise<void> {
  const packageJsonPath = join(appDir, 'package.json')
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }

  const localPackages = await collectLocalPackages()

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field]
    if (!dependencies) {
      continue
    }

    for (const pkg of localPackages) {
      if (dependencies[pkg.name]) {
        dependencies[pkg.name] = `file:${relative(appDir, pkg.sourceDir)}`
      }
    }
  }

  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // `upgrade` has just rewritten every @guren/* range to a fixture version no
  // registry has, so fail here by name rather than at `bun install`.
  await assertLocalGurenDependencies(appDir, 'The upgraded fixture app')
}

async function degradeFixtureApp(appDir: string): Promise<void> {
  const packageJsonPath = join(appDir, 'package.json')
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    scripts?: Record<string, string>
  }

  delete manifest.scripts?.codegen
  delete manifest.scripts?.typecheck

  for (const field of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[field]
    if (!dependencies) {
      continue
    }

    for (const name of Object.keys(dependencies)) {
      if (name.startsWith('@guren/')) {
        dependencies[name] = '^0.2.0-alpha.7'
      }
    }
  }

  await writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const tsconfigPath = join(appDir, 'tsconfig.json')
  const tsconfig = JSON.parse(await readFile(tsconfigPath, 'utf8')) as {
    include?: string[]
  }
  tsconfig.include = (tsconfig.include ?? []).filter((entry) => entry !== '.guren/**/*')
  await writeFile(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`, 'utf8')
}

async function main(): Promise<void> {
  const tempRoot = await mkdtemp(tempRootBase)
  const appDir = join(tempRoot, 'blog')

  try {
    await mkdir(appDir, { recursive: true })
    await cp(appFixture, appDir, { recursive: true, force: true })
    await degradeFixtureApp(appDir)

    let installInvoked = false
    const result = await upgradeCanary({
      cwd: appDir,
      // A fixture version rather than the registry: nothing here needs a real
      // lookup, and a `canary` tag would skip resolution entirely, leaving the
      // resolved path uncovered.
      versionResolver: async () => FIXTURE_VERSION,
      install: true,
      installRunner: async (cwd) => {
        installInvoked = true
        await rewriteManifestToLocalFiles(cwd)
        await run(['bun', 'install'], cwd)
      },
    })

    assert(installInvoked, 'upgrade-existing-app smoke expected installRunner to be invoked.')
    assert(result.updatedDependencies.length > 0, 'upgrade-existing-app smoke expected dependency updates.')
    assert(result.autofixes.some((autofix) => autofix.key === 'scripts' && autofix.applied), 'upgrade-existing-app smoke expected scripts autofix to apply.')
    assert(result.autofixes.some((autofix) => autofix.key === 'tsconfig' && autofix.applied), 'upgrade-existing-app smoke expected tsconfig autofix to apply.')

    const packageJson = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    assert(packageJson.scripts?.codegen, 'upgrade-existing-app smoke expected codegen script to be restored.')
    assert(packageJson.scripts?.typecheck, 'upgrade-existing-app smoke expected typecheck script to be restored.')

    const tsconfig = JSON.parse(await readFile(join(appDir, 'tsconfig.json'), 'utf8')) as {
      include?: string[]
    }
    assert(tsconfig.include?.includes('.guren/**/*'), 'upgrade-existing-app smoke expected tsconfig to include .guren/**/* after upgrade.')

    // Not `bunx guren`: `guren` is not on npm, so that spelling only works
    // while the temp app's node_modules/.bin link happens to exist and 404s
    // the moment it does not. Run the CLI source, as fresh-app.ts does.
    await run(['bun', resolve(repoRoot, 'packages/cli/src/bin.ts'), 'codegen', '--force'], appDir)
    await run(['bun', 'run', 'typecheck'], appDir)
    await run(['bun', 'run', 'build'], appDir)
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

await main()
