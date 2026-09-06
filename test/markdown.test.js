import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownStream, renderMarkdown } from '../src/markdown.js';
import { useTheme } from '../src/theme.js';

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const ON = { enabled: true };
const render = (s) => renderMarkdown(s, ON);

useTheme({ name: 'dark', colors: 256 });

test('a heading loses its hashes and gains bold', () => {
  const out = render('### The letter is a notification, not a binding act');
  assert.equal(strip(out), 'The letter is a notification, not a binding act');
  assert.ok(out.includes('\x1b[1m'));
});

test('emphasis, code, strike and links become attributes', () => {
  const out = render('a **bold** and *thin* and ~~gone~~ and `code` and [docs](https://x.dev/a)');
  assert.equal(strip(out), 'a bold and thin and gone and code and docs https://x.dev/a');
  assert.ok(out.includes('\x1b[1m'), 'bold');
  assert.ok(out.includes('\x1b[3m'), 'italic');
  assert.ok(out.includes('\x1b[9m'), 'strike');
});

test('prose that only looks like markup is left alone', () => {
  for (const line of [
    'plain snake_case stays put',
    'the product is 3 * 4 * 5',
    'a lone * asterisk',
    'call it with **kwargs when you mean it',
    'file_name_with_underscores.txt',
  ]) {
    assert.equal(strip(render(line)), line, line);
  }
});

test('what is inside a code span is content, not markup', () => {
  const out = render('use `def f(**kwargs)` and `a_b_c` today');
  assert.equal(strip(out), 'use def f(**kwargs) and a_b_c today');
});

test('lists, quotes and rules are redrawn', () => {
  assert.equal(strip(render('- one')), '• one');
  assert.equal(strip(render('  * nested')), '  • nested');
  assert.equal(strip(render('3. third')), '3. third');
  assert.equal(strip(render('> quoted')), '│ quoted');
  assert.equal(strip(render('---')), '─'.repeat(40));
});

test('a fenced block keeps every character, emphasis included', () => {
  const src = ['```js', 'const x = 3 * 4;  // **not bold**', '  indented_line;', '```'].join('\n');
  const lines = strip(render(src)).split('\n');
  assert.equal(lines[0], '  ╭─ js');
  assert.equal(lines[1], '  │ const x = 3 * 4;  // **not bold**');
  assert.equal(lines[2], '  │   indented_line;');
  assert.equal(lines[3], '  ╰────');
});

test('a fence with no language still opens and closes', () => {
  const lines = strip(render('```\nraw\n```')).split('\n');
  assert.equal(lines[0], '  ╭─ code');
  assert.equal(lines[1], '  │ raw');
  assert.equal(lines[2], '  ╰────');
});

test('the stream renders the same text however the deltas fall', () => {
  const src = '# Title\n\nsome **bold** text\n\n```py\nx = 1 * 2\n```\n\n- last *point*\n';
  const whole = render(src);
  for (const size of [1, 2, 3, 7, 13, 64]) {
    const md = markdownStream(ON);
    let out = '';
    for (let i = 0; i < src.length; i += size) out += md.write(src.slice(i, i + size));
    out += md.flush();
    assert.equal(out, whole, `chunks of ${size}`);
  }
});

test('a line is held until it is whole, then printed', () => {
  const md = markdownStream(ON);
  assert.equal(md.write('**half'), '');
  assert.equal(strip(md.write(' a line**\n')), 'half a line\n');
});

test('an answer that ends mid-line is flushed, not swallowed', () => {
  const md = markdownStream(ON);
  md.write('done: ');
  assert.equal(strip(md.flush()), 'done: ');
  assert.equal(md.flush(), '', 'flushing twice writes nothing twice');
});

test('an unclosed fence is reported and its content still printed', () => {
  const md = markdownStream(ON);
  const out = md.write('```sh\nrm -rf /\n');
  assert.equal(strip(out), '  ╭─ sh\n  │ rm -rf /\n');
  assert.equal(md.inCode, true);
});

test('with colour off the bytes are the model\'s own', () => {
  const src = '### heading\n\n- **bold** `code`\n\nplain tail';
  const md = markdownStream({ enabled: false });
  assert.equal(md.write(src) + md.flush(), src);
});
