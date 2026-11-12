import { basename } from 'node:path';
import { resolveFileArg, classifyBytes } from './filearg.js';

/**
 * `/file` anywhere in a typed line: `in this /file "a b.png" what do you see?`
 */

const MAX_WORDS = 8;

/** Whether a line has a `/file` reference, or an escaped `\/file` to unescape. */
export const mentionsFile = (line) => /(^|\s)\\?\/file(\s|$)/.test(line);

/**
 * Split a typed line into plain text and `/file <arg>` references.
 *
 * A reference starts at `/file` at the start of the line or after whitespace,
 * and must be followed by whitespace (so `/files` and `foo/file` are text). The
 * argument is a quoted string (`\"` escapes a quote inside double quotes) or,
 * unquoted, the longest run of up to eight following words for which
 * `probe(arg)` says yes, falling back to the first word so that a typo is
 * reported against the name that was typed. `\/file` is literal text and loses
 * its backslash.
 *
 * Returns `{ segments, refs }`: segments are `{ text }` or `{ ref: arg }` in
 * order; `refs` is the list of args. Without `probe` only one word is taken.
 */
export async function parseFileRefs(line, probe = null) {
  const segments = [];
  const refs = [];
  let text = '';
  const flush = () => { if (text) segments.push({ text }); text = ''; };
  let i = 0;
  while (i < line.length) {
    const atWord = i === 0 || /\s/.test(line[i - 1]);
    if (atWord && line.startsWith('\\/file', i) && /\s/.test(line[i + 6] ?? ' ')) {
      text += '/file';
      i += 6;
      continue;
    }
    if (!(atWord && line.startsWith('/file', i) && /\s/.test(line[i + 5] ?? ''))) {
      text += line[i];
      i += 1;
      continue;
    }
    let j = i + 5;
    while (j < line.length && /\s/.test(line[j])) j += 1;
    if (j >= line.length) { text += line.slice(i); i = line.length; continue; } // a bare "/file"
    let arg;
    let end;
    const q = line[j];
    if (q === '"' || q === "'") {
      let k = j + 1;
      let s = '';
      while (k < line.length && line[k] !== q) {
        if (line[k] === '\\' && q === '"' && line[k + 1] === '"') { s += '"'; k += 2; } else { s += line[k]; k += 1; }
      }
      if (k < line.length) { arg = s; end = k + 1; }
    }
    if (arg === undefined) {
      const words = [];
      const re = /\S+/g;
      re.lastIndex = j;
      for (let m = re.exec(line); m && words.length < MAX_WORDS; m = re.exec(line)) {
        if (m[0] === '/file') break;
        words.push({ s: m.index, e: m.index + m[0].length });
      }
      for (let n = words.length; n >= 1 && arg === undefined; n -= 1) {
        const stop = words[n - 1].e;
        const full = line.slice(j, stop);
        const bare = full.replace(/[?.,;:!)]+$/, '');
        if (probe && await probe(full)) { arg = full; end = stop; }
        else if (probe && bare && bare !== full && await probe(bare)) { arg = bare; end = stop - (full.length - bare.length); }
      }
      if (arg === undefined) { arg = line.slice(words[0].s, words[0].e); end = words[0].e; }
    }
    flush();
    segments.push({ ref: arg });
    refs.push(arg);
    i = end;
  }
  flush();
  return { segments, refs };
}

/** True when a parsed line is nothing but one reference: the attach-and-wait form. */
export const isBareRef = (parsed) => parsed.segments.length === 1 && parsed.refs.length === 1;

/** A probe for parseFileRefs: does this argument resolve to a file? */
export const resolves = async (arg) => {
  try { await resolveFileArg(arg); return true; } catch { return false; }
};

/**
 * Resolve every reference in parsed segments and assemble the outgoing message.
 *
 * Returns `{ errors }` (non-empty: send nothing) or `{ text, images,
 * contexts }`: the prompt with each reference replaced by a plain mention of
 * the file, the image parts that ride with it, and context blocks for text
 * files. `load` is loadImage and `read` is readFile, passed in so this module
 * stays free of the filesystem layer's imports and easy to test.
 */
export async function buildFileMessage(parsed, { resolve = resolveFileArg, load, read }) {
  const errors = [];
  const notes = [];
  const images = [];
  const contexts = [];
  let text = '';
  for (const seg of parsed.segments) {
    if (seg.text !== undefined) { text += seg.text; continue; }
    try {
      const { path, note } = await resolve(seg.ref);
      if (note) notes.push(note);
      const name = basename(path);
      const img = await load(path, { optional: true });
      if (img) { images.push(img.part); text += `[image: ${name}]`; continue; }
      const raw = await read(path);
      if (classifyBytes(raw) !== 'text') {
        errors.push(`${path} is binary and not a PNG, JPEG, WebP or GIF; not added`);
        continue;
      }
      contexts.push(`Contents of ${path}:\n\n\`\`\`\n${raw.toString('utf8')}\n\`\`\``);
      text += `[file: ${name}]`;
    } catch (e) { errors.push(e.message); }
  }
  return errors.length ? { errors, notes } : { text, images, contexts, notes };
}
