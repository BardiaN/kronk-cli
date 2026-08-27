import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRST_TAG, groupCommits, header, parseSections, parseSubject, prNumber,
  render, renderEntry, repoSlug, section,
} from '../scripts/changelog.mjs';

const SLUG = 'BardiaN/kronk-cli';
const at = (sha, subject) => ({ sha, subject });

test('a conventional subject is split into type, scope, breaking and summary', () => {
  assert.deepEqual(parseSubject('feat(sandbox): add a read-only grant channel'), {
    type: 'feat', scope: 'sandbox', breaking: false, summary: 'add a read-only grant channel',
  });
  assert.deepEqual(parseSubject('fix!: stop trusting the cached digest'), {
    type: 'fix', scope: null, breaking: true, summary: 'stop trusting the cached digest',
  });
});

// The requirement this file exists to hold: a subject that is not a
// conventional commit must reach the reader, not disappear.
test('a subject that is not a conventional commit keeps its whole text', () => {
  const subject = 'Release 0.2.1 — move every pinned action onto node24 (#51)';
  assert.deepEqual(parseSubject(subject), {
    type: null, scope: null, breaking: false, summary: subject,
  });
});

test('a type-like word that is not a type does not parse as one', () => {
  for (const subject of ['feature: x', 'fixes: y', 'feat x', 'WIP feat: z']) {
    assert.equal(parseSubject(subject).type, null, subject);
  }
});

test('non-conforming commits land in the catch-all group, never nowhere', () => {
  const commits = [
    at('a'.repeat(40), 'feat: one'),
    at('b'.repeat(40), 'Release 0.2.1 — something (#51)'),
    at('c'.repeat(40), 'merge branch whatever'),
  ];
  const groups = groupCommits(commits);
  const other = groups.find((g) => g.heading === 'Other changes');

  assert.ok(other, 'there must be a catch-all group');
  assert.equal(other.commits.length, 2);
  // The real assertion: every input commit is somewhere in the output.
  assert.equal(groups.flatMap((g) => g.commits).length, commits.length);
});

test('groups keep their declared order and empty ones are dropped', () => {
  const groups = groupCommits([at('a'.repeat(40), 'ci: x'), at('b'.repeat(40), 'feat: y')]);
  assert.deepEqual(groups.map((g) => g.heading), ['Features', 'CI']);
});

test('an entry links its pull request when the squash left a number', () => {
  const line = renderEntry(at('a'.repeat(40), 'feat(ui): widen the banner (#12)'), SLUG);
  assert.equal(line, `- **ui**: widen the banner ([#12](https://github.com/${SLUG}/pull/12))`);
});

test('an entry with no pull request number links its commit instead', () => {
  const sha = 'abcdef1234567890abcdef1234567890abcdef12';
  const line = renderEntry(at(sha, 'fix: a hand-pushed commit'), SLUG);
  assert.equal(line, `- a hand-pushed commit ([\`abcdef1\`](https://github.com/${SLUG}/commit/${sha}))`);
});

test('a non-conforming subject renders whole, minus only the PR suffix', () => {
  const line = renderEntry(at('a'.repeat(40), 'Release 0.2.1 — onto node24 (#51)'), SLUG);
  assert.ok(line.startsWith('- Release 0.2.1 — onto node24 ('), line);
});

test('a breaking change is marked', () => {
  const line = renderEntry(at('a'.repeat(40), 'feat(api)!: drop the v1 route (#9)'), SLUG);
  assert.ok(line.startsWith('- **breaking** **api**: drop the v1 route'), line);
});

test('prNumber only matches a trailing reference', () => {
  assert.equal(prNumber('feat: closes (#4) properly'), null);
  assert.equal(prNumber('feat: x (#4)'), '4');
  assert.equal(prNumber('feat: x'), null);
});

test('repoSlug reads git+https and ssh remotes, and gives up quietly', () => {
  assert.equal(repoSlug({ repository: { url: 'git+https://github.com/a/b.git' } }), 'a/b');
  assert.equal(repoSlug({ repository: { url: 'git@github.com:a/b.git' } }), 'a/b');
  assert.equal(repoSlug({}), null);
});

test('with no repo slug an entry still renders, with a bare sha', () => {
  const line = renderEntry(at('abcdef1234567890abcdef1234567890abcdef12', 'feat: x'), null);
  assert.equal(line, '- x (`abcdef1`)');
});

test('parseSections finds every release block and keeps it whole', () => {
  const text = [header(SLUG), '', '## 0.3.0 — 2026-09-01', '', '### Features', '', '- a (`x`)',
    '', '## 0.2.0 — 2026-08-23', '', '### CI', '', '- b (`y`)'].join('\n');
  const found = parseSections(text);
  assert.deepEqual([...found.keys()], ['0.3.0', '0.2.0']);
  assert.ok(found.get('0.3.0').includes('- a (`x`)'));
  assert.ok(!found.get('0.3.0').includes('- b (`y`)'), 'sections must not bleed into each other');
});

// A release PR renders one entry per branch commit; the squash merge that lands
// it collapses those into a single subject. Re-rendering a shipped release
// would swap the useful list for the opaque line, so it must not happen.
test('a published release keeps the entries it shipped with', () => {
  const shipped = {
    version: '0.3.0',
    date: '2026-09-01',
    frozen: true,
    commits: [at('z'.repeat(40), 'Release 0.3.0 — everything at once (#60)')],
  };
  const asWritten = render([{ ...shipped, frozen: false, commits: [
    at('a'.repeat(40), 'feat(sandbox): add a read-only grant channel (#57)'),
    at('b'.repeat(40), 'feat(agent): ask before a credential command runs (#58)'),
  ] }], SLUG);

  assert.ok(asWritten.includes('add a read-only grant channel'));

  const regenerated = render([shipped], SLUG, asWritten);
  assert.ok(regenerated.includes('add a read-only grant channel'),
    'the shipped entries must survive regeneration');
  assert.ok(!regenerated.includes('everything at once'),
    'the squashed subject must not replace them');
});

test('a release still being prepared is always re-rendered', () => {
  const stale = render([{
    version: '0.3.0', date: '2026-09-01', commits: [at('a'.repeat(40), 'feat: old idea')],
  }], SLUG);
  const fresh = render([{
    version: '0.3.0', date: '2026-09-01', commits: [at('a'.repeat(40), 'feat: new idea')],
  }], SLUG, stale);

  assert.ok(fresh.includes('new idea'));
  assert.ok(!fresh.includes('old idea'));
});

test('render is stable: generating twice changes nothing', () => {
  const rels = [{
    version: '0.3.0', date: '2026-09-01', frozen: true,
    commits: [at('a'.repeat(40), 'feat: x (#1)')],
  }];
  const once = render(rels, SLUG);
  assert.equal(render(rels, SLUG, once), once);
});

test('the header says where the history starts and why', () => {
  const text = header(SLUG);
  assert.ok(text.includes(FIRST_TAG), 'the boundary tag must be named');
  assert.ok(text.includes('#15'), 'the reason must be citable');
});

test('section extracts exactly one release, headings and all', () => {
  const text = render([
    { version: '0.3.0', date: '2026-09-01', commits: [at('a'.repeat(40), 'feat: newer')] },
    { version: '0.2.0', date: '2026-08-23', commits: [at('b'.repeat(40), 'ci: older')] },
  ], SLUG);

  const body = section(text, '0.3.0');
  assert.ok(body.startsWith('## 0.3.0 — 2026-09-01'));
  assert.ok(body.includes('newer'));
  assert.ok(!body.includes('older'), 'it must stop at the next release');

  assert.ok(section(text, '0.2.0').includes('older'), 'the last section runs to the end');
  assert.equal(section(text, '9.9.9'), null, 'an unknown version is null, not a guess');
});
