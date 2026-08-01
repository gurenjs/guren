/**
 * The one rule that keeps a manifest's `drizzle-orm` and `drizzle-kit` pins on
 * the copy `@guren/orm` brings with it.
 *
 * `@guren/orm` names an exact `drizzle-orm` version under `dependencies`, not a
 * range, so a manifest pinning a different one gets a second nested copy on
 * install — the app builds its table descriptors against one copy while the
 * adapter runs on the other. Aligning `@guren/*` alone is what leaves that
 * behind.
 *
 * `drizzle-kit` has no upstream declaration to read: it is not a dependency of
 * `@guren/orm`, only of apps and of the scaffold templates. Keeping the pair in
 * step is a convention rather than something npm enforces, and the two packages
 * have never shared numbers on their stable lines — so the companion release is
 * checked for existence before its version is written.
 *
 * Two callers apply this to two manifests: `guren upgrade` to an installed app,
 * against the published `@guren/orm` manifest, and `scripts/sync-template-deps.ts`
 * to the scaffold templates, against `packages/orm/package.json`.
 */
import { isExactVersion, isLocationSpecifier } from './codemods'

/** The dependency whose version is read from `@guren/orm`'s own manifest. */
export const PIN_SOURCE = 'drizzle-orm'

/** Kept in step with what `@guren/orm` depends on, not with each other. */
const DRIZZLE_PACKAGES = [PIN_SOURCE, 'drizzle-kit'] as const

/** The fields that install a copy, so a duplicate of the pinned package is possible. */
const PINNED_FIELDS = ['dependencies', 'devDependencies'] as const

/** Every field a `@guren/orm` declaration can appear in. */
const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

export type PinnedField = (typeof PINNED_FIELDS)[number]

/** The parts of a `package.json` this rule reads; anything else is ignored. */
export interface DependencyManifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/** `@guren/orm`'s own manifest — published, or the one in this workspace. */
export interface OrmManifest {
  version: string
  dependencies?: Record<string, string>
}

export interface DrizzlePinChange {
  field: PinnedField
  name: string
  previousVersion: string
  nextVersion: string
}

/**
 * Why a pin the rule looked at was left where it is.
 *
 * Refusals are part of the verdict, not narration: a caller that only reads the
 * changes cannot tell "nothing to do" from "there is drift here I will not
 * touch". `guren upgrade` reports all four to the user and moves on, while the
 * template sync fails on the two a maintainer can fix in this repository.
 */
export type DrizzlePinDeclineReason =
  /** `@guren/orm` names no single exact `drizzle-orm` version to follow. */
  | 'no-exact-pin'
  /** The pin names a place rather than a release; rewriting it would change what runs. */
  | 'location-specifier'
  /** The companion release does not exist, so there is nothing to move that pin to. */
  | 'companion-unpublished'
  /** The registry could not answer, so whether the companion release exists is unknown. */
  | 'companion-unverifiable'

export interface DrizzlePinDecline {
  reason: DrizzlePinDeclineReason
  /** Names what was left alone and why, ready to print. */
  message: string
}

export interface DrizzlePinOptions {
  /**
   * Does `<name>@<version>` exist as a release? Asked only about the companion,
   * only when its pin actually has to move — so a manifest that is already
   * aligned costs no lookup — and at most once per version within one call.
   * A rejection is not fatal here; it becomes a `companion-unverifiable`
   * decline, so an unreachable registry cannot read as "nothing to align".
   */
  companionPublished: (name: string, version: string) => Promise<boolean>
  onDecline?: (decline: DrizzlePinDecline) => void
}

interface DrizzlePin {
  field: PinnedField
  name: string
  current: string
}

function collectPins(manifest: DependencyManifest): DrizzlePin[] {
  return PINNED_FIELDS.flatMap((field) => {
    const dependencies = manifest[field] ?? {}
    return DRIZZLE_PACKAGES.filter((name) => dependencies[name]).map((name) => ({
      field,
      name,
      current: dependencies[name] as string,
    }))
  })
}

/**
 * The version being matched is the one `@guren/orm` installs, so a manifest that
 * does not use the ORM has no duplicate to avoid and no reason to follow its pin.
 */
function usesGurenOrm(manifest: DependencyManifest): boolean {
  return MANIFEST_FIELDS.some((field) => Boolean(manifest[field]?.['@guren/orm']))
}

/**
 * Whether this manifest has anything to align — checked before the ORM manifest
 * is fetched, so a manifest without drizzle pins costs no request.
 */
export function needsDrizzleAlignment(manifest: DependencyManifest): boolean {
  return collectPins(manifest).length > 0 && usesGurenOrm(manifest)
}

/**
 * The pin rewrites this manifest needs to dedupe on `@guren/orm`'s drizzle copy.
 *
 * Returns the changes rather than applying them: `guren upgrade` writes them
 * into the app manifest it already holds, while the template sync reports them
 * under `--check` and writes them otherwise, and both need the same verdict.
 * Everything this refuses to rewrite goes to `onDecline` — a caller reading only
 * the changes would take "there is drift here I will not touch" for "aligned".
 */
export async function planDrizzlePins(
  manifest: DependencyManifest,
  orm: OrmManifest,
  { companionPublished, onDecline = () => {} }: DrizzlePinOptions,
): Promise<DrizzlePinChange[]> {
  if (!needsDrizzleAlignment(manifest)) {
    return []
  }

  const source = `@guren/orm@${orm.version}`
  const pin = orm.dependencies?.[PIN_SOURCE]
  if (!pin) {
    onDecline({
      reason: 'no-exact-pin',
      message: `Could not read the ${PIN_SOURCE} version ${source} depends on — leaving the drizzle pins alone.`,
    })
    return []
  }

  // Deduping only works if the ORM names one exact version. A range would let
  // the manifest and the nested copy resolve differently, which is the situation
  // being fixed — and copying a range into `drizzle-kit` says nothing useful.
  if (!isExactVersion(pin)) {
    onDecline({
      reason: 'no-exact-pin',
      message: `${source} depends on ${PIN_SOURCE} "${pin}", which is not a single exact version — leaving the drizzle pins alone.`,
    })
    return []
  }

  // This loop is what can ask about the same package twice — `drizzle-kit`
  // declared in both `dependencies` and `devDependencies` — so the dedupe
  // belongs here rather than in every caller. A memo across *manifests* is still
  // the caller's business; this one lives and dies with the call.
  const asked = new Map<string, Promise<boolean | null>>()
  const exists = (name: string): Promise<boolean | null> => {
    let pending = asked.get(name)
    if (!pending) {
      // A registry that cannot answer is its own verdict, not a crash: the
      // template sync gates CI on this, and an npm blip must not fail a PR.
      pending = companionPublished(name, pin).catch(() => null)
      asked.set(name, pending)
    }
    return pending
  }

  const changes: DrizzlePinChange[] = []
  for (const { field, name, current } of collectPins(manifest)) {
    if (current === pin) {
      continue
    }
    if (isLocationSpecifier(current)) {
      onDecline({
        reason: 'location-specifier',
        message: `${field}.${name} is "${current}", which names a location rather than a release — leaving it alone. Align it with ${PIN_SOURCE} ${pin} yourself if you want the ORM's copy deduped.`,
      })
      continue
    }
    // Only the companion needs checking: `pin` came from the ORM's own
    // dependency on PIN_SOURCE, so that version necessarily exists.
    if (name !== PIN_SOURCE) {
      const published = await exists(name)
      if (published === null) {
        onDecline({
          reason: 'companion-unverifiable',
          message: `Could not ask npm whether ${name}@${pin} exists — leaving ${field}.${name} at "${current}".`,
        })
        continue
      }
      if (!published) {
        onDecline({
          reason: 'companion-unpublished',
          message: `${name}@${pin} does not exist on npm — leaving ${field}.${name} at "${current}". Pick the ${name} release matching ${PIN_SOURCE} ${pin} yourself.`,
        })
        continue
      }
    }
    changes.push({ field, name, previousVersion: current, nextVersion: pin })
  }

  return changes
}
