import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { safe } from './tools.js';

/** Largest image `/file` will attach. The base64 form is a third bigger again. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export const isImagePath = (p) => EXTENSIONS.has(extname(p).toLowerCase());

/**
 * The type the bytes say they are, or null.
 *
 * Sniffed rather than taken from the extension: a screenshot saved as `.png`
 * that is really a JPEG is common, and the data URL's declared type is what the
 * server's decoder is told to expect.
 */
export function sniffMime(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** An OpenAI `image_url` content part carrying the bytes inline. */
export function imagePart(buf, mime, name) {
  // `name` rides along as a non-standard field so a summary can say which file
  // it was; forWire() strips it before the request goes out.
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }, name };
}

/**
 * Read an image from inside the launch root and turn it into a content part.
 * Throws a plain-language error for a file that is too big or not an image.
 */
export async function loadImage(path) {
  const abs = safe(path);
  const { size } = await stat(abs);
  if (size > MAX_IMAGE_BYTES) {
    throw new Error(`${path} is ${(size / 1048576).toFixed(1)} MB; images are capped at ${MAX_IMAGE_BYTES / 1048576} MB`);
  }
  const buf = await readFile(abs);
  const mime = sniffMime(buf);
  if (!mime) throw new Error(`${path} does not look like a PNG, JPEG, WebP or GIF`);
  return { part: imagePart(buf, mime, basename(path)), mime, bytes: buf.length };
}

/** User-message content: the plain string when there are no images. */
export function buildContent(text, parts) {
  if (!parts?.length) return text;
  return [{ type: 'text', text }, ...parts];
}

const placeholder = (p) => `[image: ${p.name ?? 'image'}]`;

/**
 * Message content as text, for anything that measures, summarizes or prints a
 * message. An image becomes a placeholder: inlining its base64 would burn the
 * summarizer's window on noise and write it into a transcript for good.
 */
export function textOf(content) {
  if (Array.isArray(content)) {
    return content
      .map((p) => (p?.type === 'image_url' ? placeholder(p) : (p?.text ?? '')))
      .join('\n');
  }
  return content == null ? '' : String(content);
}

/** The request copy of a message: drops the bookkeeping `name` from image parts. */
export function forWire(m) {
  if (!Array.isArray(m.content)) return m;
  return {
    ...m,
    content: m.content.map((p) => {
      if (p?.type !== 'image_url') return p;
      const rest = { ...p };
      delete rest.name;
      return rest;
    }),
  };
}

export const hasImage = (m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url');
