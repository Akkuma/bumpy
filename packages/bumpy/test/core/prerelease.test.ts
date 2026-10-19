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
  packageExistsOnRegistry,
  buildChannelReleasePlan,
} from '../../src/core/prerelease.ts';
import { makePkg, makeRelease, makeReleasePlan, createTempGitRepo, cleanupTempDir } from '../helpers.ts';
import { resetMockState, uninstallShellMock, addMockRule, getCallsMatching } from '../helpers-shell-mock.ts';
import { tryRunArgs } from '../../src/utils/shell.ts';

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
  const channel = {
    name: 'alpha',
    branch: 'alpha',
    preid: 'alpha',
    tag: 'alpha',
    versionPr: { title: 'Versioned prerelease (alpha)', branch: 'bumpy/release-alpha', automerge: false },
  };
  const plan = makeReleasePlan([makeRelease('pkg', '0.1.0', { oldVersion: '0.0.0' })]);
  const packages = new Map([['pkg', makePkg('pkg', '0.0.0')]]);

  beforeEach(() => resetMockState());
  afterAll(() => uninstallShellMock());

  test('returns versions from the default lookup', async () => {
    addMockRule({ match: 'npm info pkg versions --json', response: '["1.0.0","1.1.0-rc.0"]' });
    expect(await fetchPublishedVersions('pkg', { tag: 'next' })).toEqual({
      versions: ['1.0.0', '1.1.0-rc.0'],
      unresolved: false,
    });
    expect(getCallsMatching('pkg@next')).toHaveLength(0);
  });

  test('falls back to the dist-tag hint when there is no `latest`', async () => {
    addMockRule(NO_LATEST);
    addMockRule({ match: 'npm info pkg@alpha versions --json', response: '["0.1.0-alpha.0"]' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({
      versions: ['0.1.0-alpha.0'],
      unresolved: false,
    });
  });

  test('passes the registry through to both lookups', async () => {
    addMockRule({ match: /^npm info pkg versions --json --registry https:\/\/r\.example$/, response: '' });
    addMockRule({
      match: 'npm info pkg@alpha versions --json --registry https://r.example',
      response: '"0.1.0-alpha.0"',
    });
    const result = await fetchPublishedVersions('pkg', { registry: 'https://r.example', tag: 'alpha' });
    expect(result.versions).toEqual(['0.1.0-alpha.0']);
  });

  test('flags unresolved when neither `latest` nor the hint resolve', async () => {
    addMockRule(NO_LATEST);
    addMockRule({
      match: 'npm info pkg@alpha versions --json',
      error: 'npm error code E404\nNo match found for version alpha',
    });
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
    addMockRule({ match: 'npm info pkg@alpha versions --json', error: 'npm error code ETIMEDOUT' });
    expect(await fetchPublishedVersions('pkg', { tag: 'alpha' })).toEqual({
      versions: [],
      unresolved: 'lookup-failed',
    });
  });

  test('isVersionOnRegistry checks the exact version', async () => {
    addMockRule({ match: 'npm info pkg@1.0.0-pr-1-abc version --json', response: '"1.0.0-pr-1-abc"' });
    addMockRule({ match: 'npm info pkg@1.0.0-pr-2-abc version --json', error: 'E404' });
    expect(await isVersionOnRegistry('pkg', '1.0.0-pr-1-abc')).toBe(true);
    expect(await isVersionOnRegistry('pkg', '1.0.0-pr-2-abc')).toBe(false);
  });

  // Trusted publishing (OIDC) can't create a package, so `bumpy publish` checks for it first
  test.each([
    {
      manager: 'npm' as const,
      state: 'published',
      rule: { match: /^npm info pkg versions --json$/, response: '["1.0.0"]' },
      exists: true,
    },
    { manager: 'npm' as const, state: 'without `latest`', rule: NO_LATEST, exists: true },
    {
      manager: 'npm' as const,
      state: 'missing',
      rule: { match: /^npm info pkg versions --json$/, error: 'npm error code E404\nnpm error 404 Not Found' },
      exists: false,
    },
    {
      manager: 'pnpm' as const,
      state: 'without `latest`',
      rule: {
        match: /^pnpm view pkg versions --json$/,
        error: '{"error":{"code":"ERR_PNPM_PACKAGE_NOT_FOUND","message":"No matching version found for pkg@latest"}}',
      },
      exists: true,
    },
    {
      manager: 'pnpm' as const,
      state: 'missing',
      rule: {
        match: /^pnpm view pkg versions --json$/,
        error: '{"error":{"code":"ERR_PNPM_FETCH_404","message":"GET https://r/pkg: Not Found - 404"}}',
      },
      exists: false,
    },
    {
      manager: 'bun' as const,
      state: 'without `latest`',
      rule: {
        match: /^bun info pkg versions --json$/,
        error: '{ "error": "No matching version found", "version": "pkg" }',
      },
      exists: true,
    },
    {
      manager: 'bun' as const,
      state: 'missing',
      rule: {
        match: /^bun info pkg versions --json$/,
        error: "404 Not Found: https://r/pkg\n - 'pkg@latest' does not exist",
      },
      exists: false,
    },
    {
      manager: 'yarn' as const,
      state: 'published',
      rule: { match: /^yarn npm info pkg --fields versions --json$/, response: '{"name":"pkg","versions":["1.0.0"]}' },
      exists: true,
    },
    {
      manager: 'yarn' as const,
      state: 'missing',
      rule: {
        match: /^yarn npm info pkg --fields versions --json$/,
        error: '{"type":"error","name":35,"displayName":"YN0035","data":"  Response Code: 404 (Not Found)"}',
      },
      exists: false,
    },
  ])('$manager: packageExistsOnRegistry is $exists when $state', async ({ manager, rule, exists }) => {
    addMockRule({ match: /^(npm|pnpm|bun|yarn) /, error: 'unexpected registry command' });
    addMockRule(rule);
    expect(await packageExistsOnRegistry('pkg', { manager })).toBe(exists);
    expect(getCallsMatching(rule.match)).toHaveLength(1);
  });

  describe('buildChannelReleasePlan', () => {
    test('counts prereleases on a registry without `latest`', async () => {
      addMockRule(NO_LATEST);
      addMockRule({ match: 'npm info pkg@alpha versions --json', response: '["0.1.0-alpha.0","0.1.0-alpha.1"]' });
      const { plan: out, warnings } = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), {
        forDisplay: true,
      });
      expect(out.releases[0]!.newVersion).toBe('0.1.0-alpha.2');
      expect(warnings).toEqual([]);
    });

    test('warns when the version list cannot be read', async () => {
      addMockRule(NO_LATEST);
      addMockRule({
        match: 'npm info pkg@alpha versions --json',
        error: 'npm error code E404\nNo match found for version alpha',
      });
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

  // The lookups run with `publish.publishManager`, so the registry is read with the same client
  // (and the same auth config) that publishes. Responses below are what each CLI printed against
  // a registry whose package only has an `alpha` dist-tag.
  describe('with another publish manager', () => {
    const NPM_FORBIDDEN = { match: /^npm /, error: 'npm must not run when publishManager is not npm' };

    const noLatest = [
      {
        manager: 'pnpm' as const,
        rules: [
          {
            match: /^pnpm view pkg versions --json$/,
            error:
              '{"error":{"code":"ERR_PNPM_PACKAGE_NOT_FOUND","message":"No matching version found for pkg@latest"}}',
          },
          { match: /^pnpm view pkg@alpha versions --json$/, response: '["0.1.0-alpha.0","0.1.0-alpha.1"]' },
        ],
      },
      {
        manager: 'bun' as const,
        rules: [
          {
            match: /^bun info pkg versions --json$/,
            error: '{ "error": "No matching version found", "version": "pkg" }',
          },
          { match: /^bun info pkg@alpha versions --json$/, response: '["0.1.0-alpha.0","0.1.0-alpha.1"]' },
        ],
      },
      {
        manager: 'yarn' as const,
        rules: [
          {
            match: /^yarn npm info pkg --fields versions --json$/,
            response: '{"name":"pkg","versions":["0.1.0-alpha.0","0.1.0-alpha.1"]}',
          },
        ],
      },
    ];

    test.each(noLatest)('$manager: counts prereleases on a registry without `latest`', async ({ manager, rules }) => {
      addMockRule(NPM_FORBIDDEN);
      for (const rule of rules) addMockRule(rule);
      const { plan: out, warnings } = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), {
        forDisplay: true,
        publishManager: manager,
      });
      expect(out.releases[0]!.newVersion).toBe('0.1.0-alpha.2');
      expect(warnings).toEqual([]);
      expect(getCallsMatching(/^npm /)).toHaveLength(0);
    });

    const missingPackage = [
      {
        manager: 'pnpm' as const,
        error: '{"error":{"code":"ERR_PNPM_FETCH_404","message":"GET https://r/pkg: Not Found - 404"}}',
      },
      {
        manager: 'bun' as const,
        error: "404 Not Found: https://r/pkg\n - 'pkg@latest' does not exist in this registry",
      },
      {
        manager: 'yarn' as const,
        error: '{"type":"error","name":35,"displayName":"YN0035","data":"  Response Code: 404 (Not Found)"}',
      },
    ];

    test.each(missingPackage)('$manager: a missing package is not unresolved', async ({ manager, error }) => {
      addMockRule(NPM_FORBIDDEN);
      addMockRule({ match: /versions/, error });
      expect(await fetchPublishedVersions('pkg', { tag: 'alpha', manager })).toEqual({
        versions: [],
        unresolved: false,
      });
    });

    test('pnpm: a non-404 failure is lookup-failed', async () => {
      addMockRule(NPM_FORBIDDEN);
      addMockRule({
        match: /versions/,
        error: '{"error":{"code":"ERR_PNPM_FETCH_401","message":"Unauthorized - 401"}}',
      });
      expect(await fetchPublishedVersions('pkg', { tag: 'alpha', manager: 'pnpm' })).toEqual({
        versions: [],
        unresolved: 'lookup-failed',
      });
      expect(getCallsMatching(/^pnpm view pkg versions/)).toHaveLength(1);
    });

    // yarn answers a spec that matches nothing with the newest manifest instead of failing
    test('yarn: an exact-version check rejects the manifest yarn substitutes', async () => {
      addMockRule(NPM_FORBIDDEN);
      addMockRule({
        match: /^yarn npm info pkg@1\.0\.0 --fields version --json$/,
        response: '{"name":"pkg","version":"1.0.0"}',
      });
      addMockRule({
        match: /^yarn npm info pkg@9\.9\.9 --fields version --json$/,
        response: '{"name":"pkg","version":"1.0.0"}',
      });
      expect(await isVersionOnRegistry('pkg', '1.0.0', { manager: 'yarn' })).toBe(true);
      expect(await isVersionOnRegistry('pkg', '9.9.9', { manager: 'yarn' })).toBe(false);
    });

    test('pnpm: isVersionOnRegistry reads the exact version', async () => {
      addMockRule(NPM_FORBIDDEN);
      addMockRule({
        match: /^pnpm view pkg@1\.0\.0 version --json --registry https:\/\/r\.example$/,
        response: '"1.0.0"',
      });
      addMockRule({
        match: /^pnpm view pkg@9\.9\.9 version --json/,
        error: '{"error":{"code":"ERR_PNPM_PACKAGE_NOT_FOUND","message":"No matching version found for pkg@9.9.9"}}',
      });
      expect(await isVersionOnRegistry('pkg', '1.0.0', { registry: 'https://r.example', manager: 'pnpm' })).toBe(true);
      expect(await isVersionOnRegistry('pkg', '9.9.9', { manager: 'pnpm' })).toBe(false);
    });

    describe('yarn: published-from-HEAD check', () => {
      const head = tryRunArgs(['git', 'rev-parse', 'HEAD'])!;
      const yarnRules = (gitHeadResponse: object) => {
        addMockRule(NPM_FORBIDDEN);
        addMockRule({
          match: /^yarn npm info pkg --fields versions --json$/,
          response: '{"name":"pkg","versions":["0.1.0-alpha.0","0.1.0-alpha.1"]}',
        });
        addMockRule({
          match: /^yarn npm info pkg@0\.1\.0-alpha\.1 --fields version,gitHead --json$/,
          response: JSON.stringify(gitHeadResponse),
        });
      };

      test('gitHead of the requested version marks it already published', async () => {
        yarnRules({ name: 'pkg', version: '0.1.0-alpha.1', gitHead: head });
        const out = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), { publishManager: 'yarn' });
        expect(out.alreadyPublished).toEqual([{ name: 'pkg', version: '0.1.0-alpha.1' }]);
      });

      test('gitHead from a substituted manifest is ignored', async () => {
        yarnRules({ name: 'pkg', version: '9.9.9', gitHead: head });
        const out = await buildChannelReleasePlan(plan, channel, packages, process.cwd(), { publishManager: 'yarn' });
        expect(out.alreadyPublished).toEqual([]);
        expect(out.plan.releases[0]!.newVersion).toBe('0.1.0-alpha.2');
      });
    });
  });
});
