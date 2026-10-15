import { resolve } from 'node:path';
import { readFileAtRef } from './git.ts';
import {
  CATALOG_FILES,
  catalogYamlFile,
  detectPackageManager,
  diffCatalogMaps,
  isCatalogRefAffected,
  parseCatalogs,
} from '../utils/package-manager.ts';
import type { CatalogMap } from '../utils/package-manager.ts';
import { exists, readText } from '../utils/fs.ts';
import { DEP_TYPES } from '../types.ts';
import type { WorkspacePackage } from '../types.ts';

/**
 * Catalog change detection shared by `bumpy check` and `bumpy generate`.
 *
 * Catalog definitions live in root-level files (`pnpm-workspace.yaml`, `.yarnrc.yml`,
 * `package.json`), so a commit that only bumps a catalog entry touches no package
 * directory. To attribute such a change to the packages it actually affects, diff the
 * catalogs between two refs and look up which packages reference the changed entries
 * via the `catalog:` protocol.
 */

/** Map of catalogName → set of depNames whose entries changed */
export type CatalogChanges = Map<string, Set<string>>;

/** Whether any of `changedFiles` may define catalogs */
export function touchesCatalogFiles(changedFiles: string[]): boolean {
  return changedFiles.some((f) => (CATALOG_FILES as readonly string[]).includes(f));
}

/** Load catalog definitions at a git ref, or from the working tree when `ref` is null */
export async function loadCatalogsAt(rootDir: string, ref: string | null): Promise<CatalogMap> {
  const pm = await detectPackageManager(rootDir);
  // The workspace YAML that may hold catalogs: pnpm-workspace.yaml for pnpm,
  // .yarnrc.yml for Yarn, and none for npm/bun (which use package.json).
  const yamlFile = catalogYamlFile(pm);
  if (ref) {
    return parseCatalogs(
      yamlFile ? readFileAtRef(rootDir, ref, yamlFile) : null,
      readFileAtRef(rootDir, ref, 'package.json'),
    );
  }
  const read = async (file: string) =>
    (await exists(resolve(rootDir, file))) ? readText(resolve(rootDir, file)) : null;
  return parseCatalogs(yamlFile ? await read(yamlFile) : null, await read('package.json'));
}

/**
 * Compute which catalog entries changed between `beforeRef` and `afterRef` (the working
 * tree when null). Returns an empty map when none of `changedFiles` is a catalog file,
 * so the git reads are skipped in the common case.
 */
export async function getChangedCatalogEntries(
  rootDir: string,
  beforeRef: string,
  afterRef: string | null,
  changedFiles: string[],
): Promise<CatalogChanges> {
  if (!touchesCatalogFiles(changedFiles)) return new Map();
  const [before, after] = await Promise.all([loadCatalogsAt(rootDir, beforeRef), loadCatalogsAt(rootDir, afterRef)]);
  return diffCatalogMaps(before, after);
}

/** Packages with a `catalog:` dependency (in any dep field) that resolves to a changed catalog entry */
export function findCatalogConsumers(
  packages: Map<string, WorkspacePackage>,
  catalogChanges: CatalogChanges,
): string[] {
  if (catalogChanges.size === 0) return [];
  const consumers: string[] = [];
  for (const [name, pkg] of packages) {
    const affected = DEP_TYPES.some((depType) =>
      Object.entries(pkg[depType] ?? {}).some(([depName, range]) =>
        isCatalogRefAffected(range, depName, catalogChanges),
      ),
    );
    if (affected) consumers.push(name);
  }
  return consumers;
}
