import { readFileSync } from 'node:fs';

/**
 * The one place that reads this package's own version.
 *
 * Everything that needs to say what build this is — the `--version` flag, the
 * MCP `clientInfo` handshake, the update check's idea of "current" — imports
 * `VERSION` from here instead of carrying its own copy. `src/mcp.js` used to
 * hardcode `'0.1.0'` and nothing ever noticed it had fallen six releases
 * behind, because nothing read the real number. `package.json` is in the
 * published `files` allowlist, so this works on every install route: npm,
 * Homebrew, the install script, and a git checkout all ship the real file.
 */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;

/**
 * `kronk version 1.32.7\n` -> `1.32.7`. `runKronk(['--version'])` is the one
 * door this program uses to ask the `kronk` binary anything, and this is the
 * one place that makes sense of what comes back. Falls back to the first line
 * rather than to null, on the theory that an unexpected format is still more
 * informative on screen than nothing — but only the first line, and only so
 * much of it: `runKronk` captures up to CAPTURE_CAP of whatever the binary
 * decided to print, and `--version` is one line of output, not a place to
 * empty a stack trace into.
 */
const STRAY_MAX = 60;

export function parseKronkVersion(stdout) {
  const m = String(stdout).match(/version\s+(\S+)/i);
  if (m) return m[1];
  const first = String(stdout).split('\n')[0].trim();
  return first ? first.slice(0, STRAY_MAX) : null;
}
