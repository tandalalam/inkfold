#!/usr/bin/env node
// Stand-in for the `t3` CLI used by tests/e2e.mjs, so tests never message a real thread.
// Supports: thread send <id> - --json --wait   and   thread show <id> --json --messages N
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATE = path.join(process.env.FAKE_T3_DIR || os.tmpdir(), 'fake-t3-state.json');
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { messages: [], runs: 0, active: null };
  }
};
const save = (s) => fs.writeFileSync(STATE, JSON.stringify(s));
const [, , group, cmd, threadId, ...rest] = process.argv;

const thread = (s) => ({
  threadId,
  title: 'Fake research thread',
  status: s.active ? 'running' : 'completed',
  activeRunId: s.active,
  link: 'https://example.invalid/thread',
});

if (group === 'thread' && cmd === 'show') {
  const s = load();
  console.log(JSON.stringify({ thread: thread(s), messages: s.messages.slice(-40) }));
} else if (group === 'thread' && cmd === 'send' && rest[0] === '-') {
  const input = fs.readFileSync(0, 'utf8');
  const s = load();
  const runId = `run:${++s.runs}`;
  s.active = runId;
  s.messages.push({ role: 'user', runId, text: input });
  s.messages.push({ role: 'assistant', runId, text: 'Looking at the selection…' });
  save(s);
  setTimeout(() => {
    const clipCount = (input.match(/^\[\d+\] /gm) || []).length;
    const allImagesExist = [...input.matchAll(/^\[\d+\] (\S+)/gm)].every((m) => fs.existsSync(m[1]));
    const q = /My question: (.*)/.exec(input)?.[1] ?? '';
    const reply =
      `**Answer** to “${q}” with ${clipCount} clip(s)${allImagesExist ? '' : ' (MISSING IMAGES)'}.\n\n` +
      'Inline math \\(a^2+b^2=c^2\\) and display:\n\\[\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\\]\n\n' +
      '- dollar math $x_1 \\le 15$\n- <script>alert(1)</script> stays text';
    const st = load();
    st.active = null;
    st.messages.push({ role: 'assistant', runId, text: reply });
    save(st);
    console.log(JSON.stringify({ threadId, runId, status: 'completed', reply, error: null }));
  }, Number(process.env.FAKE_T3_DELAY || 1500));
} else {
  console.error('fake-t3: unsupported', process.argv.slice(2).join(' '));
  process.exit(3);
}
