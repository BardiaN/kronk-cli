#!/usr/bin/env node
/**
 * Generate CHANGELOG.md from the conventional commits already on master.
 *
 * Every pull request is squash-merged, so one commit on master is one change,
 * and #15 made the subject line a conventional commit. That is a
 * machine-readable release history; this script is the machine that reads it.
 *
 * No dependency, not even a devDependency. `git log` and a regular expression
 * are the whole implementation. The alternative considered was git-cliff, which
 * is a better tool in general and the wrong one here: it means pinning another
 * third-party action into `release.yml`, and this repository's own
 * `dependabot.yml` says why that is not free — "a compromised action sees the
 * release secrets". A hundred lines of local JavaScript has no such reach.
 *
 * Usage:
 *   node scripts/changelog.mjs                 write CHANGELOG.md
 *   node scripts/changelog.mjs --section 0.3.0 print one release's body
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The convention starts here.
 *
 * #15 made Conventional Commits mandatory and said explicitly that existing
 * history is not to be rewritten. v0.2.0 is the first release whose commits all
 * follow it, so this file begins there and the older tags keep whatever their
 * GitHub Releases already say. Walking further back would not produce history,
 * it would produce a wall of "Other changes" — the honest rendering of commits
 * written before the rule existed, and worth nothing to a reader.
 */
export const FIRST_TAG = 'v0.2.0';

/**
 * Section order and headings. `null` is the catch-all for a subject that is not
 * a conventional commit at all.
 *
 * Nothing is filtered. A `chore(release):` commit is a real entry and appears
 * as one, and so does the squashed merge that shipped it even though its
 * subject reads "Release 0.2.1 — …" and parses as nothing. Silent omission is
 * the failure mode this file exists to avoid: a changelog that quietly drops
 * what it cannot classify is worse than one with an ugly line in it, because
 * only the second kind tells you it happened.
 */
const GROUPS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['test', 'Tests'],
  ['build', 'Build'],
  ['ci', 'CI'],
  ['chore', 'Chores'],
  [null, 'Other changes'],
];

const TYPES = GROUPS.map(([t]) => t).filter(Boolean);
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\(([^)]*)\\))?(!)?: (.+)$`);

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** `owner/repo` from package.json, for the links each entry carries. */
export function repoSlug(pkg) {
  const url = pkg?.repository?.url ?? '';
  const m = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

/**
 * Split one subject into its parts.
 *
 * A subject that does not match is not an error and not dropped — it comes back
 * with `type: null` and its full text as the summary, which puts it in the
 * catch-all group.
 */
export function parseSubject(subject) {
  const m = SUBJECT.exec(subject);
  if (!m) return { type: null, scope: null, breaking: false, summary: subject };
  return { type: m[1], scope: m[3] ?? null, breaking: Boolean(m[4]), summary: m[5] };
}

/** The trailing `(#123)` a squash merge leaves behind, if there is one. */
export function prNumber(subject) {
  const m = subject.match(/\(#(\d+)\)\s*$/);
  return m ? m[1] : null;
}

/**
 * One rendered bullet. Links to the pull request when the squash left a number,
 * and to the commit when it did not — a hand-pushed commit still gets a link,
 * just a different one.
 */
export function renderEntry({ subject, sha }, slug) {
  const { type, scope, breaking, summary } = parseSubject(subject);
  const pr = prNumber(subject);
  const text = (type ? summary : subject).replace(/\s*\(#\d+\)\s*$/, '');
  const link = slug
    ? (pr
      ? `[#${pr}](https://github.com/${slug}/pull/${pr})`
      : `[\`${sha.slice(0, 7)}\`](https://github.com/${slug}/commit/${sha})`)
    : `\`${sha.slice(0, 7)}\``;
  const prefix = [breaking ? '**breaking**' : null, scope ? `**${scope}**:` : null]
    .filter(Boolean).join(' ');
  return `- ${prefix ? `${prefix} ` : ''}${text} (${link})`;
}

/** Group a release's commits into the sections above, dropping empty ones. */
export function groupCommits(commits) {
  const buckets = new Map(GROUPS.map(([t]) => [t, []]));
  for (const commit of commits) {
    const { type } = parseSubject(commit.subject);
    buckets.get(buckets.has(type) ? type : null).push(commit);
  }
  return GROUPS
    .map(([type, heading]) => ({ heading, commits: buckets.get(type) }))
    .filter((g) => g.commits.length);
}

/** `v1.2.3` tags, oldest first, ignoring anything that is not one. */
function tags() {
  return git('tag', '--list', 'v*', '--sort=v:refname')
    .split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
}

function commitsIn(range) {
  const out = git('log', '--no-merges', '--format=%H%x00%s', range);
  if (!out) return [];
  return out.split('\n').map((line) => {
    const [sha, subject] = line.split('\0');
    return { sha, subject };
  });
}

const iso = (ref) => git('log', '-1', '--format=%cs', ref);

/**
 * Every release to render, newest first.
 *
 * Commits after the newest tag are attributed to `pendingVersion` — the version
 * in package.json — rather than to an "Unreleased" heading. In this repository
 * a version bump *is* the release trigger, so by the time these commits exist
 * the version they will ship as is already decided and sitting in package.json.
 * Calling that "Unreleased" would mean the release PR could never show the
 * section it is about to publish.
 */
export function releases({ allTags, pendingVersion, head = 'HEAD' }) {
  const known = allTags.slice(allTags.indexOf(FIRST_TAG));
  if (!known.length) return [];
  const out = [];

  const newest = allTags[allTags.length - 1];
  if (pendingVersion && !allTags.includes(`v${pendingVersion}`)) {
    const commits = commitsIn(`${newest}..${head}`);
    if (commits.length) out.push({ version: pendingVersion, date: iso(head), commits });
  }

  for (let i = known.length - 1; i >= 0; i--) {
    const tag = known[i];
    const prev = allTags[allTags.indexOf(tag) - 1];
    out.push({
      version: tag.replace(/^v/, ''),
      date: iso(tag),
      commits: commitsIn(prev ? `${prev}..${tag}` : tag),
      frozen: true,
    });
  }
  return out;
}

export function renderSection(rel, slug) {
  const lines = [`## ${rel.version} — ${rel.date}`, ''];
  for (const group of groupCommits(rel.commits)) {
    lines.push(`### ${group.heading}`, '');
    for (const commit of group.commits) lines.push(renderEntry(commit, slug));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function header(slug) {
  return [
    '# Changelog',
    '',
    'Generated from the commit history by `npm run changelog` — do not edit by hand.',
    '',
    'Every entry is one squash-merged pull request, grouped by its'
    + ' [Conventional Commits](https://www.conventionalcommits.org) type. A commit whose subject'
    + ' does not parse as one is not dropped; it appears under **Other changes**.',
    '',
    `Releases before \`${FIRST_TAG}\` predate the convention (#15) and are deliberately not`
    + ' back-filled — see the'
    + (slug ? ` [releases page](https://github.com/${slug}/releases)` : ' releases page')
    + ' for those.',
  ].join('\n');
}

/** Every `## <version> — <date>` block already in the file, keyed by version. */
export function parseSections(text) {
  const found = new Map();
  const re = /^## (\d+\.\d+\.\d+) — /gm;
  const starts = [...text.matchAll(re)];
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    found.set(m[1], text.slice(m.index, end).trimEnd());
  });
  return found;
}

/**
 * A published release's entry is frozen once written.
 *
 * Re-rendering it from git would actively destroy information. A release PR
 * lists one entry per real commit on its branch; the squash merge that lands it
 * replaces all of them with a single subject, so regenerating an already-shipped
 * section turns a useful list into one opaque line that parses as nothing. The
 * commits it described are still in history, but no longer reachable from any
 * range this script walks.
 *
 * So git is consulted only for releases the file does not already describe —
 * which on a first run is all of them, and afterwards is only the one being
 * prepared.
 */
export function render(rels, slug, existing = '') {
  const kept = parseSections(existing);
  const body = rels.map((rel) => (rel.frozen && kept.has(rel.version)
    ? kept.get(rel.version)
    : renderSection(rel, slug)));
  return `${[header(slug), ...body].join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** One release's body, headings and all, for the GitHub Release. */
export function section(text, version) {
  const start = text.indexOf(`\n## ${version} — `);
  if (start === -1) return null;
  const after = text.indexOf('\n## ', start + 1);
  return text.slice(start + 1, after === -1 ? undefined : after + 1).trimEnd();
}

function main(argv) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const file = join(ROOT, 'CHANGELOG.md');
  let existing = '';
  try { existing = readFileSync(file, 'utf8'); } catch { /* first run */ }
  const wanted = render(
    releases({ allTags: tags(), pendingVersion: pkg.version }),
    repoSlug(pkg),
    existing,
  );

  // --section reads the file as committed, never a fresh render. The release
  // body and the changelog are then the same bytes by construction rather than
  // by two generators agreeing, and they cannot drift.
  //
  // They would otherwise drift immediately: a release PR renders one entry per
  // real commit on its branch, and the squash merge that lands it collapses all
  // of them into a single subject. Regenerating here would replace the useful
  // rendering with the opaque one, at exactly the moment it is published.
  const sectionAt = argv.indexOf('--section');
  if (sectionAt !== -1) {
    const version = (argv[sectionAt + 1] ?? pkg.version).replace(/^v/, '');
    const body = section(existing, version);
    if (!body) {
      console.error(`CHANGELOG.md has no section for ${version}.`);
      console.error('Run `npm run changelog` in the release commit and commit the result.');
      return 1;
    }
    process.stdout.write(`${body}\n`);
    return 0;
  }

  writeFileSync(file, wanted);
  console.log(`wrote CHANGELOG.md (${wanted.split('\n## ').length - 1} releases)`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
