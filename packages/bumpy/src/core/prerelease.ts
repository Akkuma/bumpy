import { resolve } from 'node:path';
import { tryParse } from 'verkit';
import { readText, writeText, updateJsonFields, updateJsonNestedField } from '../utils/fs.ts';
import { runArgsAsync, tryRunArgs } from '../utils/shell.ts';
import { listTags } from './git.ts';
import type { ResolvedChannel } from './channels.ts';
import type { ReleasePlan, PlannedRelease, PublishConfig, WorkspacePackage } from '../types.ts';

/**
 * Prerelease versions are never committed to git — they are derived at publish time:
 * the target (major.minor.patch) comes from the cycle's bump files via the normal
 * release plan, and the counter comes from the registry: max published `-<preid>.N`
 * for that target, plus one. This makes counters immune to branch resets, abandoned
 * cycles, and re-runs.
 */

/** Published prerelease state for one package at one target version */
export interface PublishedPrereleaseState {
  /** Existing counters for `<target>-<preid>.N` on the registry (or git tags for non-npm packages) */
  counters: number[];
  /** Whether the stable target version itself is already published */
  stablePublished: boolean;
  /** Why the registry's version list couldn't be read, if it couldn't (see `PublishedVersions.unresolved`) */
  unresolved?: PublishedVersions['unresolved'];
}

/**
 * Extract existing prerelease counters for a target+preid from a list of published versions.
 * Only exact `<target>-<preid>.<N>` versions count — other preids and targets are ignored.
 */
export function extractPrereleaseCounters(versions: string[], target: string, preid: string): number[] {
  const counters: number[] = [];
  for (const v of versions) {
    const parsed = tryParse(v);
    if (!parsed) continue;
    if (`${parsed.major}.${parsed.minor}.${parsed.patch}` !== target) continue;
    const prerelease = parsed.prerelease ?? [];
    if (prerelease.length !== 2) continue;
    if (prerelease[0] !== preid) continue;
    const n = prerelease[1];
    if (typeof n === 'number') counters.push(n);
  }
  return counters;
}

/** Compute the next prerelease version: `<target>-<preid>.<max existing counter + 1>` */
export function nextPrereleaseVersion(target: string, preid: string, existingCounters: number[]): string {
  const next = existingCounters.length > 0 ? Math.max(...existingCounters) + 1 : 0;
  return `${target}-${preid}.${next}`;
}

/** Published versions of a package, as listed by the registry */
export interface PublishedVersions {
  versions: string[];
  /**
   * Why the version list couldn't be read (`versions` is empty, but not because nothing is published):
   * - `no-dist-tag` — the package exists, but the default lookup resolves through the `latest`
   *   dist-tag and matches nothing when it's missing, which happens on registries that only set
   *   the tag you publish with (e.g. GCP Artifact Registry)
   * - `lookup-failed` — the registry query failed for a reason other than "not found"
   *   (auth, network, 5xx, malformed response)
   */
  unresolved: false | 'no-dist-tag' | 'lookup-failed';
}

export type PublishManager = PublishConfig['publishManager'];

/**
 * Why a lookup returned no value: `not-found` means no such package, `empty` means the spec
 * matched no version (e.g. the `latest` it resolved through doesn't exist), `failed` is anything else.
 */
type LookupFailure = 'not-found' | 'empty' | 'failed';

type ExactField = 'version' | 'gitHead';

/** How one publish manager's CLI reads package metadata from the registry */
interface RegistryReader {
  versionsArgs: (spec: string, registry?: string) => string[];
  fieldArgs: (spec: string, field: ExactField, registry?: string) => string[];
  /** The field's value from the parsed output; `version` is the one an exact read asked for */
  extract: (parsed: unknown, field: 'versions' | ExactField, version?: string) => unknown;
  /** Classify a failed command by its error message */
  classify: (message: string) => LookupFailure;
}

const registryFlag = (registry?: string) => (registry ? ['--registry', registry] : []);

function infoCommandReader(command: string[], classify: RegistryReader['classify']): RegistryReader {
  return {
    versionsArgs: (spec, registry) => [...command, spec, 'versions', '--json', ...registryFlag(registry)],
    fieldArgs: (spec, field, registry) => [...command, spec, field, '--json', ...registryFlag(registry)],
    extract: (parsed) => parsed,
    classify,
  };
}

const REGISTRY_READERS: Record<PublishManager, RegistryReader> = {
  npm: infoCommandReader(['npm', 'info'], (message) => (/\bE404\b/.test(message) ? 'not-found' : 'failed')),
  pnpm: infoCommandReader(['pnpm', 'view'], (message) => {
    if (message.includes('ERR_PNPM_FETCH_404')) return 'not-found';
    if (message.includes('ERR_PNPM_PACKAGE_NOT_FOUND')) return 'empty';
    return 'failed';
  }),
  bun: infoCommandReader(['bun', 'info'], (message) => {
    if (message.includes('404 Not Found')) return 'not-found';
    if (message.includes('No matching version found')) return 'empty';
    return 'failed';
  }),
  // yarn has no --registry flag (it reads .yarnrc.yml) and wraps each field in the manifest
  yarn: {
    versionsArgs: (spec) => ['yarn', 'npm', 'info', spec, '--fields', 'versions', '--json'],
    fieldArgs: (spec, field) => [
      'yarn',
      'npm',
      'info',
      spec,
      '--fields',
      field === 'version' ? 'version' : `version,${field}`,
      '--json',
    ],
    // For a version that doesn't exist yarn prints the newest manifest instead of failing
    extract: (parsed, field, version) => {
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const manifest = new Map(Object.entries(parsed));
      if (version !== undefined && manifest.get('version') !== version) return undefined;
      return manifest.get(field);
    },
    classify: (message) => (message.includes('Response Code: 404') ? 'not-found' : 'failed'),
  },
};

/** List the versions `spec` (`name` or `name@<tag>`) resolves to on the registry */
async function queryVersions(
  spec: string,
  registry: string | undefined,
  manager: PublishManager,
): Promise<string[] | LookupFailure> {
  const reader = REGISTRY_READERS[manager];
  let raw: string;
  try {
    raw = await runArgsAsync(reader.versionsArgs(spec, registry));
  } catch (err) {
    return reader.classify(err instanceof Error ? err.message : String(err));
  }
  if (!raw.trim()) return 'empty';
  try {
    const versions = reader.extract(JSON.parse(raw), 'versions');
    if (Array.isArray(versions)) return versions.filter((v) => typeof v === 'string');
    if (typeof versions === 'string') return [versions]; // single-version packages
    return 'failed';
  } catch {
    return 'failed';
  }
}

/**
 * Fetch all published versions of a package from the registry.
 *
 * Tries the default lookup (via `latest`) first, then falls back to `opts.tag` — the
 * dist-tag bumpy publishes this release under — for packages that have no `latest`.
 */
export async function fetchPublishedVersions(
  name: string,
  opts: { registry?: string; tag?: string; manager?: PublishManager } = {},
): Promise<PublishedVersions> {
  const manager = opts.manager ?? 'npm';
  const viaLatest = await queryVersions(name, opts.registry, manager);
  if (Array.isArray(viaLatest)) return { versions: viaLatest, unresolved: false };
  // Package doesn't exist yet (first publish ever)
  if (viaLatest === 'not-found') return { versions: [], unresolved: false };
  if (viaLatest === 'failed') return { versions: [], unresolved: 'lookup-failed' };

  if (opts.tag && opts.tag !== 'latest') {
    const viaTag = await queryVersions(`${name}@${opts.tag}`, opts.registry, manager);
    if (Array.isArray(viaTag)) return { versions: viaTag, unresolved: false };
    if (viaTag === 'failed') return { versions: [], unresolved: 'lookup-failed' };
  }
  return { versions: [], unresolved: 'no-dist-tag' };
}

/** Read one field of an exact published version; `undefined` when the version or field isn't there */
async function readExactField(
  name: string,
  version: string,
  field: ExactField,
  opts: { registry?: string; manager?: PublishManager },
): Promise<unknown> {
  const reader = REGISTRY_READERS[opts.manager ?? 'npm'];
  try {
    const raw = await runArgsAsync(reader.fieldArgs(`${name}@${version}`, field, opts.registry));
    return raw.trim() ? reader.extract(JSON.parse(raw), field, version) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an exact version of a package is on the registry (no dist-tag resolution involved) */
export async function isVersionOnRegistry(
  name: string,
  version: string,
  opts: { registry?: string; manager?: PublishManager } = {},
): Promise<boolean> {
  return (await readExactField(name, version, 'version', opts)) === version;
}

/** Fetch the gitHead recorded for a published version (set by npm publish from a git checkout) */
async function fetchGitHead(
  name: string,
  version: string,
  opts: { registry?: string; manager?: PublishManager } = {},
): Promise<string | null> {
  const sha = await readExactField(name, version, 'gitHead', opts);
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Whether a package publishes through the npm registry (vs custom command / git-tag tracking) */
export function usesNpmRegistry(pkg: WorkspacePackage): boolean {
  return !pkg.bumpy?.publishCommand && !pkg.bumpy?.skipNpmPublish && !pkg.private;
}

/** Query published prerelease state for one package at a target version */
export async function getPublishedPrereleaseState(
  pkg: WorkspacePackage,
  target: string,
  preid: string,
  rootDir: string,
  distTag?: string,
  manager?: PublishManager,
): Promise<PublishedPrereleaseState> {
  if (usesNpmRegistry(pkg)) {
    const { versions, unresolved } = await fetchPublishedVersions(pkg.name, {
      registry: pkg.bumpy?.registry,
      tag: distTag,
      manager,
    });
    return {
      counters: extractPrereleaseCounters(versions, target, preid),
      stablePublished: versions.includes(target),
      unresolved,
    };
  }
  // Non-npm packages (custom publish command / skipNpmPublish) — derive from git tags,
  // matching how the stable flow tracks their published-ness.
  const tagVersions = listTags(`${pkg.name}@${target}-${preid}.*`, { cwd: rootDir }).map((t) =>
    t.slice(pkg.name.length + 1),
  );
  return {
    counters: extractPrereleaseCounters(tagVersions, target, preid),
    stablePublished: listTags(`${pkg.name}@${target}`, { cwd: rootDir }).length > 0,
  };
}

export interface ChannelReleasePlanResult {
  /** The plan with prerelease versions applied (packages already published from HEAD removed) */
  plan: ReleasePlan;
  /** Packages skipped because their latest prerelease was already published from this commit */
  alreadyPublished: Array<{ name: string; version: string }>;
  warnings: string[];
}

/**
 * Transform a stable release plan (targets computed from bump files) into a channel
 * prerelease plan: each release's newVersion becomes `<target>-<preid>.<N>` with N
 * derived from the registry floor.
 *
 * Idempotency: if a package's latest published prerelease for this target records a
 * gitHead equal to HEAD (or, for non-npm packages, its tag points at HEAD), the package
 * was already published from this exact commit — it is skipped rather than re-counted.
 */
export async function buildChannelReleasePlan(
  stablePlan: ReleasePlan,
  channel: ResolvedChannel,
  packages: Map<string, WorkspacePackage>,
  rootDir: string,
  opts: {
    /**
     * Display mode (release PR titles/bodies, status output): compute counters but
     * skip the published-from-HEAD checks — the numbers are advisory narrative and
     * the registry wins at actual publish time.
     */
    forDisplay?: boolean;
    publishManager?: PublishManager;
  } = {},
): Promise<ChannelReleasePlanResult> {
  const headSha = tryRunArgs(['git', 'rev-parse', 'HEAD'], { cwd: rootDir });
  const warnings: string[] = [...stablePlan.warnings];
  const alreadyPublished: Array<{ name: string; version: string }> = [];
  const releases: PlannedRelease[] = [];

  await Promise.all(
    stablePlan.releases.map(async (release) => {
      const pkg = packages.get(release.name);
      if (!pkg) return;
      // Unpublishable packages can't participate in a registry-consumable cycle
      if (pkg.private && !pkg.bumpy?.publishCommand) return;

      const target = release.newVersion; // stable target from the bump files
      const state = await getPublishedPrereleaseState(
        pkg,
        target,
        channel.preid,
        rootDir,
        channel.tag,
        opts.publishManager,
      );

      if (state.unresolved) {
        const reason =
          state.unresolved === 'no-dist-tag'
            ? `exists on the registry but has neither a "latest" nor a "${channel.tag}" dist-tag`
            : 'could not be looked up on the registry';
        warnings.push(
          `${release.name} ${reason}, so its published versions couldn't be listed — ` +
            `the prerelease counter starts at 0 and may collide.`,
        );
      }

      if (state.stablePublished) {
        warnings.push(
          `${release.name}@${target} is already published as a stable release — ` +
            `merge ${target}'s release into the "${channel.branch}" branch so the cycle retargets.`,
        );
      }

      if (!opts.forDisplay && state.counters.length > 0 && headSha) {
        const latest = `${target}-${channel.preid}.${Math.max(...state.counters)}`;
        const publishedFromHead = usesNpmRegistry(pkg)
          ? (await fetchGitHead(pkg.name, latest, { registry: pkg.bumpy?.registry, manager: opts.publishManager })) ===
            headSha
          : tryRunArgs(['git', 'rev-parse', `refs/tags/${pkg.name}@${latest}`], { cwd: rootDir }) === headSha;
        if (publishedFromHead) {
          alreadyPublished.push({ name: release.name, version: latest });
          return;
        }
      }

      releases.push({
        ...release,
        newVersion: nextPrereleaseVersion(target, channel.preid, state.counters),
      });
    }),
  );

  releases.sort((a, b) => a.name.localeCompare(b.name));
  return {
    plan: { bumpFiles: stablePlan.bumpFiles, releases, warnings },
    alreadyPublished,
    warnings,
  };
}

/**
 * Transiently write computed versions (and exact pins for in-plan deps) into the
 * working tree's package.json files. Returns a restore function that puts the
 * original contents back — call it in a `finally` after publishing. Used by both
 * the channel prerelease flow and snapshot releases — neither commits its versions.
 *
 * Versions must be on disk before build/pack so that:
 * - PM pack picks up the version for the tarball
 * - builds that bake in the version (banners, __VERSION__) see the right one
 *
 * In-plan dependencies are pinned EXACTLY (`"1.2.0-rc.0"`, no range) so any
 * combination of packages installed from the dist-tag resolves to the
 * coherent set it was published with.
 */
export async function writeTransientVersionsInPlace(
  plan: ReleasePlan,
  packages: Map<string, WorkspacePackage>,
): Promise<() => Promise<void>> {
  const releaseMap = new Map(plan.releases.map((r) => [r.name, r]));
  const originals = new Map<string, string>();

  for (const release of plan.releases) {
    const pkg = packages.get(release.name);
    if (!pkg) continue;
    const pkgJsonPath = resolve(pkg.dir, 'package.json');
    originals.set(pkgJsonPath, await readText(pkgJsonPath));

    await updateJsonFields(pkgJsonPath, { version: release.newVersion });

    // Exact-pin in-cycle deps (dev deps excluded — not installed by consumers)
    for (const depField of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      const deps = pkg[depField];
      for (const depName of Object.keys(deps)) {
        const depRelease = releaseMap.get(depName);
        if (!depRelease) continue;
        await updateJsonNestedField(pkgJsonPath, depField, depName, depRelease.newVersion);
      }
    }
  }

  return async () => {
    for (const [path, content] of originals) {
      await writeText(path, content);
    }
  };
}

/**
 * Derive display versions for a channel cycle without touching the registry:
 * each target gets a wildcard counter (`1.2.0-rc.x`). Everything here comes from
 * committed state (bump files + config), so PR titles/bodies and commit messages
 * can never disagree with what eventually publishes. Unpublishable packages are
 * dropped, mirroring the filter in `buildChannelReleasePlan`.
 */
export function channelDisplayPlan(
  stablePlan: ReleasePlan,
  channel: ResolvedChannel,
  packages: Map<string, WorkspacePackage>,
): ReleasePlan {
  const releases = stablePlan.releases
    .filter((r) => {
      const pkg = packages.get(r.name);
      return !!pkg && !(pkg.private && !pkg.bumpy?.publishCommand);
    })
    .map((r) => ({ ...r, newVersion: `${r.newVersion}-${channel.preid}.x` }));
  return { ...stablePlan, releases };
}

/** One-line summary of a channel plan's versions, for PR titles and commit messages */
export function formatChannelVersionSummary(releases: PlannedRelease[]): string {
  if (releases.length === 0) return '';
  if (releases.length === 1) return `${releases[0]!.name}@${releases[0]!.newVersion}`;
  return `${releases.length} packages`;
}
