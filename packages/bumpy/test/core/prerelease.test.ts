import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  extractPrereleaseCounters,
  nextPrereleaseVersion,
  writeTransientVersionsInPlace,
  formatChannelVersionSummary,
  channelDisplayPlan,
  fetchPublishedVersions,
  isVersionOnRegistry,
  buildChannelReleasePlan,
} from '../../src/core/prerelease.ts';
import { makePkg, makeRelease, makeReleasePlan, createTempGitRepo, cleanupTempDir } from '../helpers.ts';
import { resetMockState, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';

describe('extractPrereleaseCounters', () => {
  test('extracts counters for matching target + preid only', () => {
    const versions = [
      '1.1.0', // stable — ignored
      '1.2.0-rc.0',
      '1.2.0-rc.3',
      '1.2.0-beta.5', // different preid — ignored
      '1.3.0-rc.1', // different target — ignored
      '1.2.0-rc.x', // non-numeric counter — ignored
      '1.2.0-rc.1.hotfix', // extra identifier — ignored
    ];
    expect(extractPrereleaseCounters(versions, '1.2.0', 'rc').sort((a, b) => a - b)).toEqual([0, 3]);
  });

  test('returns empty for no matches', () => {
    expect(extractPrereleaseCounters(['1.0.0', '2.0.0-beta.0'], '1.2.0', 'rc')).toEqual([]);
    expect(extractPrereleaseCounters([], '1.2.0', 'rc')).toEqual([]);
  });
});

describe('nextPrereleaseVersion', () => {
  test('starts at .0 when nothing published', () => {
    expect(nextPrereleaseVersion('1.2.0', 'rc', [])).toBe('1.2.0-rc.0');
  });

  test('counts above the max published counter (registry floor)', () => {
    expect(nextPrereleaseVersion('1.2.0', 'rc', [0, 1, 3])).toBe('1.2.0-rc.4');
  });

  test('counter resets implicitly when the target moves (no committed state)', () => {
    // published 1.2.0-rc.0..3, then a major lands → target becomes 2.0.0
    expect(nextPrereleaseVersion('2.0.0', 'rc', extractPrereleaseCounters(['1.2.0-rc.3'], '2.0.0', 'rc'))).toBe(
      '2.0.0-rc.0',
    );
  });
});

describe('writeTransientVersionsInPlace', () => {
  test('writes prerelease versions and exact-pins in-cycle deps, then restores', async () => {
    const dir = await createTempGitRepo();
    try {
      const coreDir = resolve(dir, 'packages/core');
      const pluginDir = resolve(dir, 'packages/plugin');
      await mkdir(coreDir, { recursive: true });
      await mkdir(pluginDir, { recursive: true });

      const coreJson = JSON.stringify({ name: 'core', version: '1.1.0' }, null, 2) + '\n';
      const pluginJson =
        JSON.stringify(
          {
            name: 'plugin',
            version: '1.0.0',
            dependencies: { core: 'workspace:^', lodash: '^4.0.0' },
            peerDependencies: { core: '^1.0.0' },
            devDependencies: { core: 'workspace:*' },
          },
          null,
          2,
        ) + '\n';
      await writeFile(resolve(coreDir, 'package.json'), coreJson);
      await writeFile(resolve(pluginDir, 'package.json'), pluginJson);

      const core = makePkg('core', '1.1.0', { dir: coreDir });
      const plugin = makePkg('plugin', '1.0.0', {
        dir: pluginDir,
        dependencies: { core: 'workspace:^', lodash: '^4.0.0' },
        peerDependencies: { core: '^1.0.0' },
        devDependencies: { core: 'workspace:*' },
      });
      const packages = new Map([
        ['core', core],
        ['plugin', plugin],
      ]);

      const plan = makeReleasePlan([
        makeRelease('core', '1.2.0-rc.1', { oldVersion: '1.1.0' }),
        makeRelease('plugin', '1.0.1-rc.1', { oldVersion: '1.0.0' }),
      ]);

      const restore = await writeTransientVersionsInPlace(plan, packages);

      const writtenCore = JSON.parse(await readFile(resolve(coreDir, 'package.json'), 'utf-8'));
      const writtenPlugin = JSON.parse(await readFile(resolve(pluginDir, 'package.json'), 'utf-8'));
      expect(writtenCore.version).toBe('1.2.0-rc.1');
      expect(writtenPlugin.version).toBe('1.0.1-rc.1');
      // In-cycle deps exact-pinned (no range, no workspace: protocol)
      expect(writtenPlugin.dependencies.core).toBe('1.2.0-rc.1');
      expect(writtenPlugin.peerDependencies.core).toBe('1.2.0-rc.1');
      // Out-of-cycle deps untouched
      expect(writtenPlugin.dependencies.lodash).toBe('^4.0.0');
      // Dev deps untouched (not installed by consumers)
      expect(writtenPlugin.devDependencies.core).toBe('workspace:*');

      await restore();
      expect(await readFile(resolve(coreDir, 'package.json'), 'utf-8')).toBe(coreJson);
      expect(await readFile(resolve(pluginDir, 'package.json'), 'utf-8')).toBe(pluginJson);
    } finally {
      await cleanupTempDir(dir);
    }
  });
});

describe('formatChannelVersionSummary', () => {
  test('single release shows name@version', () => {
    expect(formatChannelVersionSummary([makeRelease('core', '1.2.0-rc.x')])).toBe('core@1.2.0-rc.x');
  });

  test('multiple releases show a count instead of an arbitrary lead', () => {
    const releases = [
      makeRelease('plugin', '1.0.1-rc.x', { isDependencyBump: true }),
      makeRelease('core', '1.2.0-rc.x'),
      makeRelease('utils', '2.0.1-rc.x', { isDependencyBump: true }),
    ];
    expect(formatChannelVersionSummary(releases)).toBe('3 packages');
  });

  test('empty plan', () => {
    expect(formatChannelVersionSummary([])).toBe('');
  });
});

describe('channelDisplayPlan', () => {
  const channel = {
    name: 'next',
    branch: 'next',
    preid: 'rc',
    tag: 'next',
    versionPr: { title: '🐸 Versioned prerelease (next)', branch: 'bumpy/release-next', automerge: false },
  };

  test('appends a wildcard counter to each target', () => {
    const plan = makeReleasePlan([makeRelease('core', '1.2.0', { oldVersion: '1.1.0' })]);
    const packages = new Map([['core', makePkg('core', '1.1.0')]]);
    const display = channelDisplayPlan(plan, channel, packages);
    expect(display.releases.map((r) => r.newVersion)).toEqual(['1.2.0-rc.x']);
  });

  test('drops unpublishable packages, keeps private ones with a publishCommand', () => {
    const plan = makeReleasePlan([
      makeRelease('core', '1.2.0'),
      makeRelease('internal', '0.5.0'),
      makeRelease('cli', '2.0.0'),
    ]);
    const packages = new Map([
      ['core', makePkg('core', '1.1.0')],
      ['internal', makePkg('internal', '0.4.0', { private: true })],
      ['cli', makePkg('cli', '1.9.0', { private: true, bumpy: { publishCommand: 'cargo publish' } })],
    ]);
    const display = channelDisplayPlan(plan, channel, packages);
    expect(display.releases.map((r) => r.name)).toEqual(['core', 'cli']);
  });
});

// Registries like GCP Artifact Registry only set the dist-tag you publish with, so a
// prerelease-only package has no `latest`. `npm info <name> versions` resolves through
// `latest` and prints nothing (exit 0) in that case — see issue #163.
describe('registry version lookup', () => {
  const NO_LATEST = { match: /^npm info pkg versions --json$/, response: '' };

  beforeEach(() => resetMockState());
  afterAll(() => uninstallShellMock());

  test('returns versions from the default lookup', async () => {
    addMockRule({ match: 'npm info pkg versions --json', response: '["1.0.0","1.1.0-rc.0"]' });
    expect(await fetchPublishedVersions('pkg', { tag: 'next' })).toEqual({
      versions: ['1.0.0', '1.1.0-rc.0'],
      unresolved: false,
    });
    expect(getCallsMatching('--tag')).toHaveLength(0);
  });

  test('falls back to the dist-tag hint when there is no `latest`', async () => {
    addMockRule(NO_LATEST);
    addMockRule({ match: 'npm info pkg versions --json --tag alpha', response: '["0.1.0-alpha.0"]' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({
      versions: ['0.1.0-alpha.0'],
      unresolved: false,
    });
  });

  test('passes the registry through to both lookups', async () => {
    addMockRule({ match: /^npm info pkg versions --json --registry https:\/\/r\.example$/, response: '' });
    addMockRule({ match: '--tag alpha --registry https://r.example', response: '"0.1.0-alpha.0"' });
    const result = await fetchPublishedVersions('pkg', { registry: 'https://r.example', tag: 'alpha' });
    expect(result.versions).toEqual(['0.1.0-alpha.0']);
  });

  test('flags unresolved when neither `latest` nor the hint resolve', async () => {
    addMockRule(NO_LATEST);
    addMockRule({ match: '--tag alpha', error: 'npm error code E404\nNo match found for version alpha' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({ versions: [], unresolved: 'no-dist-tag' });
    resetMockState();
    addMockRule(NO_LATEST);
    expect(await fetchPublishedVersions('pkg')).toEqual({ versions: [], unresolved: 'no-dist-tag' });
  });

  test('a missing package is not unresolved', async () => {
    addMockRule({ match: 'npm info pkg versions', error: 'npm error code E404\nnpm error 404 Not Found' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({ versions: [], unresolved: false });
  });

  test('flags lookup-failed for non-404 failures', async () => {
    addMockRule({ match: 'npm info pkg versions', error: 'npm error code E401\nnpm error Unable to authenticate' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({
      versions: [],
      unresolved: 'lookup-failed',
    });
    resetMockState();
    addMockRule({ match: 'npm info pkg versions', response: '<html>bad gateway</html>' });
    expect(await fetchPublishedVersions('pkg')).toEqual({ versions: [], unresolved: 'lookup-failed' });
    // the dist-tag fallback failing for a non-404 reason is a lookup failure too
    resetMockState();
    addMockRule(NO_LATEST);
    addMockRule({ match: '--tag alpha', error: 'npm error code ETIMEDOUT' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({
      versions: [],
      unresolved: 'lookup-failed',
    });
  });

  test('isVersionOnRegistry checks the exact version', async () => {
    addMockRule({ match: 'npm info pkg@1.0.0-pr-1-abc version', response: '1.0.0-pr-1-abc' });
    addMockRule({ match: 'npm info pkg@1.0.0-pr-2-abc version', error: 'E404' });
    expect(await isVersionOnRegistry('pkg', '1.0.0-pr-1-abc')).toBe(true);
    expect(await isVersionOnRegistry('pkg', '1.0.0-pr-2-abc')).toBe(false);
  });

  describe('buildChannelReleasePlan', () => {
    const channel = {
      name: 'alpha',
      branch: 'alpha',
      preid: 'alpha',
      tag: 'alpha',
      versionPr: { title: 'Versioned prerelease (alpha)', branch: 'bumpy/release-alpha', automerge: false },
    };
    const plan = makeReleasePlan([makeRelease('pkg', '0.1.0', { oldVersion: '0.0.0' })]);
    const packages = new Map([['pkg', makePkg('pkg', '0.0.0')]]);

    test('counts prereleases on a registry without `latest`', async () => {
      addMockRule(NO_LATEST);
      addMockRule({ match: '--tag alpha', response: '["0.1.0-alpha.0","0.1.0-alpha.1"]' });
      const { plan: out, warnings } = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), {
        forDisplay: true,
      });
      expect(out.releases[0]!.newVersion).toBe('0.1.0-alpha.2');
      expect(warnings).toEqual([]);
    });

    test('warns when the version list cannot be read', async () => {
      addMockRule(NO_LATEST);
      addMockRule({ match: '--tag alpha', error: 'npm error code E404\nNo match found for version alpha' });
      const { plan: out, warnings } = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), {
        forDisplay: true,
      });
      expect(out.releases[0]!.newVersion).toBe('0.1.0-alpha.0');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('neither a "latest" nor a "alpha" dist-tag');
    });

    test('warns when the registry lookup fails', async () => {
      addMockRule({ match: 'npm info pkg versions', error: 'npm error code E500' });
      const { warnings } = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), { forDisplay: true });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('could not be looked up on the registry');
    });
  });
});
