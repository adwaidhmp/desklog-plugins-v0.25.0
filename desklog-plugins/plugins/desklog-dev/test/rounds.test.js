// A round's tokens must survive however the round ends. No network, no model.
//   node --test test/rounds.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'scripts', 'hook.js');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'desklog-rounds-'));

function run(name, input, env) {
  const r = spawnSync('node', [HOOK, name], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, DESKLOG_TRANSCRIPT_WAIT_MS: '200', ...env },
  });
  assert.equal(r.status, 0, `${name} must exit 0 (stderr: ${r.stderr})`);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

const U = (i, o) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });

// Writes a worker transcript; call again with more messages to simulate it growing.
function transcript(dir, file, taskId, messages) {
  const lines = [{ type: 'user', message: { role: 'user', content: `DESKLOG_TASK_ID: ${taskId}\nDo the work.` } }];
  for (const m of messages) {
    lines.push({ type: 'assistant', timestamp: m.at || '2026-09-30T09:00:00Z',
      message: { id: m.id, content: [{ type: 'text', text: m.text || '' }], usage: m.usage } });
  }
  const f = path.join(dir, file);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

const record = (d, taskId) => {
  const f = path.join(d, 'usage', `${taskId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
const roundsOf = (d, taskId) => Object.values(record(d, taskId).rounds);
const start = (file, agentId, taskId) => ({ hook_event_name: 'SubagentStart', session_id: 's1',
  agent_id: agentId, agent_transcript_path: file, prompt: `DESKLOG_TASK_ID: ${taskId}\nDo the work.` });
const stop = (file, agentId, last) => ({ hook_event_name: 'SubagentStop', session_id: 's1',
  agent_id: agentId, agent_transcript_path: file, last_assistant_message: last });
const sweep = (event) => ({ hook_event_name: event });
const complete = (taskId) => ({ hook_event_name: 'PreToolUse',
  tool_name: 'mcp__desklog__change_task_status', tool_input: { task_id: taskId, status: 'Done' } });
const injected = (out) => out.hookSpecificOutput.updatedInput.ai_usage;

// ---------------------------------------------------------------- normal completion

test('normal completion: one round, counted once, marked completed', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 'r1.jsonl', '900', [{ id: 'm1', usage: U(100, 10), text: 'ok\nRESULT: DONE' }]);
  run('round-start', start(f, 'a1', '900'), env);
  assert.equal(roundsOf(d, '900')[0].status, 'running', 'registered the moment it starts');

  run('record-usage', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  const r = roundsOf(d, '900')[0];
  assert.equal(r.status, 'completed');
  assert.equal(r.result, 'done');
  assert.equal(r.usage.total_tokens, 110);

  const out = run('status-pre', complete('900'), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(injected(out).usage.total_tokens, 110, 'counted once, not twice');
  assert.equal(injected(out).source.rounds, 1);
  assert.equal(injected(out).summary, undefined, 'a clean completion needs no note');
});

test('a finished round is never double-counted, however often it is measured', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 'r1.jsonl', '900', [{ id: 'm1', usage: U(100, 10), text: 'ok\nRESULT: DONE' }]);
  run('round-start', start(f, 'a1', '900'), env);
  run('record-usage', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  run('record-usage', stop(f, 'a1', 'ok\nRESULT: DONE'), env);   // reported again
  run('sweep', sweep('SessionStart'), env);                       // and swept
  assert.equal(Object.keys(record(d, '900').rounds).length, 1);
  assert.equal(injected(run('status-pre', complete('900'), env)).usage.total_tokens, 110);
});

// ---------------------------------------------------------------- interruptions

test('connection failure mid-round: the tokens spent so far are kept', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '0' };
  const f = transcript(d, 'r1.jsonl', '901', [{ id: 'm1', usage: U(5000, 300), text: 'halfway through' }]);
  run('round-start', start(f, 'a1', '901'), env);
  // the round dies: no SubagentStop ever arrives. Next sweep closes the books.
  run('sweep', sweep('Stop'), env);

  const r = roundsOf(d, '901')[0];
  assert.equal(r.status, 'interrupted');
  assert.equal(r.usage.total_tokens, 5300, 'what it spent before dying is kept');
  assert.equal(r.result, null, 'it never reported a result');
});

test('session closed mid-round: the round is cancelled, its tokens kept', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 'r1.jsonl', '902', [{ id: 'm1', usage: U(2000, 100), text: 'working' }]);
  run('round-start', start(f, 'a1', '902'), env);
  const out = run('sweep', sweep('SessionEnd'), env);

  const r = roundsOf(d, '902')[0];
  assert.equal(r.status, 'cancelled');
  assert.equal(r.usage.total_tokens, 2100);
  assert.match(out.systemMessage, /902/, 'the user is told what was kept');
});

test('manual stop: the round is interrupted once its transcript stops growing', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '0' };
  const f = transcript(d, 'r1.jsonl', '903', [{ id: 'm1', usage: U(800, 50), text: 'partway' }]);
  run('round-start', start(f, 'a1', '903'), env);
  run('sweep', sweep('SessionStart'), env);
  assert.equal(roundsOf(d, '903')[0].status, 'interrupted');
  assert.equal(roundsOf(d, '903')[0].usage.total_tokens, 850);
});

test('a round still running is left alone until it goes stale', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '600000' };
  const f = transcript(d, 'r1.jsonl', '904', [{ id: 'm1', usage: U(10, 1), text: 'working' }]);
  run('round-start', start(f, 'a1', '904'), env);
  run('sweep', sweep('Stop'), env);
  const r = roundsOf(d, '904')[0];
  assert.equal(r.status, 'running', 'a live round must not be declared interrupted');
  assert.equal(r.usage.total_tokens, 11, 'but its usage is updated as it goes');
});

// ---------------------------------------------------------------- the whole story

test('four interrupted rounds then one good round: every token is reported', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '0' };
  // what happened on task 125748: connection error, two session closures, a manual stop
  const spent = [1000, 2000, 3000, 4000];
  spent.forEach((n, i) => {
    const f = transcript(d, `r${i}.jsonl`, '905', [{ id: `m${i}`, usage: U(n, 0), text: 'cut off' }]);
    run('round-start', start(f, `a${i}`, '905'), env);
    run('sweep', sweep(i === 1 ? 'SessionEnd' : 'Stop'), env);
  });
  // the completion is still refused — no finished round yet
  const denied = run('status-pre', complete('905'), env).hookSpecificOutput;
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /ASK THE USER which they want/);

  // then one short round that ends properly
  const f = transcript(d, 'final.jsonl', '905', [{ id: 'mf', usage: U(500, 50), text: 'lint clean\nRESULT: DONE' }]);
  run('round-start', start(f, 'af', '905'), env);
  run('record-usage', stop(f, 'af', 'lint clean\nRESULT: DONE'), env);

  const out = run('status-pre', complete('905'), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(injected(out).usage.total_tokens, 10550, '1000+2000+3000+4000+550');
  assert.equal(injected(out).source.rounds, 5);
  assert.equal(injected(out).result, 'done', 'the finished round decides the result');
  assert.equal(injected(out).usage_complete, false, 'and it says the figures are not clean');

  const statuses = roundsOf(d, '905').map((r) => r.status).sort();
  assert.deepEqual(statuses, ['cancelled', 'completed', 'interrupted', 'interrupted', 'interrupted']);
});

test('a good round followed by an interrupted one does NOT clear the task', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '0' };
  const good = transcript(d, 'good.jsonl', '907', [{ id: 'm1', usage: U(100, 10), text: 'ok\nRESULT: DONE' }]);
  run('round-start', start(good, 'a1', '907'), env);
  run('record-usage', stop(good, 'a1', 'ok\nRESULT: DONE'), env);
  assert.equal(run('status-pre', complete('907'), env).hookSpecificOutput.permissionDecision, 'allow');

  // more feedback, and that round is cut off: the files may be half-edited
  const cut = transcript(d, 'cut.jsonl', '907', [{ id: 'm2', usage: U(400, 20), text: 'editing' }]);
  run('round-start', start(cut, 'a2', '907'), env);
  run('sweep', sweep('Stop'), env);

  const out = run('status-pre', complete('907'), env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny', 'the newer interrupted round must not pass silently');
  assert.match(out.permissionDecisionReason, /ASK THE USER which they want/);

  // one clean round later, everything is counted
  const fin = transcript(d, 'fin.jsonl', '907', [{ id: 'm3', usage: U(50, 5), text: 'ok\nRESULT: DONE' }]);
  run('round-start', start(fin, 'a3', '907'), env);
  run('record-usage', stop(fin, 'a3', 'ok\nRESULT: DONE'), env);
  const ok = run('status-pre', complete('907'), env);
  assert.equal(ok.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(injected(ok).usage.total_tokens, 585, '110 + 420 interrupted + 55');
});

test('the user may close a half-done task: approved partial keeps what was measured', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '0' };
  const f = transcript(d, 'r1.jsonl', '908', [{ id: 'm1', usage: U(3000, 200), text: 'changed half the page' }]);
  run('round-start', start(f, 'a1', '908'), env);
  run('sweep', sweep('Stop'), env);            // the user stopped it part-way

  // first attempt: refused, with instructions to ask the user
  const asked = run('status-pre', complete('908'), env).hookSpecificOutput;
  assert.equal(asked.permissionDecision, 'deny');
  assert.match(asked.permissionDecisionReason, /mark it Done now with the work recorded so far/);
  assert.match(asked.permissionDecisionReason, /ai_partial_confirmed: true/);

  // the user chose "Done now"
  const ok = run('status-pre', { ...complete('908'), tool_input: { task_id: '908', status: 'Done', ai_partial_confirmed: true } }, env);
  const out = ok.hookSpecificOutput;
  assert.equal(out.permissionDecision, 'allow');
  assert.equal(injected(ok).usage.total_tokens, 3200, 'everything measured up to the interruption');
  assert.equal(injected(ok).result, 'done', "Desklog stores usage only for a completion");
  assert.equal(injected(ok).usage_complete, false, 'but it says plainly the work was never verified');
  assert.equal(out.updatedInput.ai_partial_confirmed, undefined, 'the marker is for the hook, not for Desklog');
  assert.equal(injected(ok).summary, undefined, 'the note goes in the task description, not in ai_usage');
});

test('approving a partial completion cannot invent work that never happened', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const out = run('status-pre',
    { ...complete('909'), tool_input: { task_id: '909', status: 'Done', ai_partial_confirmed: true } }, env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny', 'no rounds at all means nothing to report');
  assert.match(out.permissionDecisionReason, /Desklog web app/);
});

test('a task cannot be completed while a round is still running', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '600000' };
  const f = transcript(d, 'r1.jsonl', '906', [{ id: 'm1', usage: U(10, 1), text: 'working' }]);
  run('round-start', start(f, 'a1', '906'), env);
  const out = run('status-pre', complete('906'), env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /may still be running/);
  assert.match(out.permissionDecisionReason, /ASK THE USER/);
});

test('a subagent that is not a Desklog round is ignored at both ends', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = path.join(d, 'other.jsonl');
  fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'unrelated work' } }) + '\n');
  run('round-start', { hook_event_name: 'SubagentStart', agent_id: 'x', agent_transcript_path: f, prompt: 'unrelated' }, env);
  run('record-usage', stop(f, 'x', 'done'), env);
  assert.equal(fs.existsSync(path.join(d, 'usage')), false, 'no record for a non-Desklog subagent');
});


// ---------------------------------------------------------------- the 126066 bug
// The worker ran and spent tokens, but no round was ever recorded: the start event did not
// carry the prompt, and the transcript was still empty when it fired.

const approve = (taskId, extra = {}) => ({ hook_event_name: 'PreToolUse', tool_name: 'mcp__desklog__change_task_status',
  tool_input: { task_id: taskId, status: 'Done', ai_partial_confirmed: true }, ...extra });

test('start event without the prompt, empty transcript: parked, then recovered with its tokens', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = path.join(d, 'agent.jsonl');
  fs.writeFileSync(f, '');                                   // nothing written yet
  run('round-start', { hook_event_name: 'SubagentStart', agent_id: 'w1', agent_transcript_path: f }, env);
  assert.equal(record(d, '126066'), null, 'not resolvable yet — must be parked, not dropped');
  const parked = JSON.parse(fs.readFileSync(path.join(d, 'state', 'pending-rounds.json'), 'utf8'));
  assert.ok(parked.w1, 'parked under its agent id');

  // the worker runs, writes its task id and spends tokens — then the user stops it
  transcript(d, 'agent.jsonl', '126066', [{ id: 'm1', usage: U(4000, 300), text: 'exploring files' }]);
  const out = run('status-pre', approve('126066'), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(injected(out).usage.total_tokens, 4300, 'the tokens it spent are reported');
  assert.equal(injected(out).usage_complete, false);
});

test('no start hook at all: the round is discovered in the session folder', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const main = path.join(d, 'sess-1.jsonl');
  fs.writeFileSync(main, '');
  const sub = path.join(d, 'sess-1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  transcript(sub, 'agent-abc123.jsonl', '126066', [{ id: 'm1', usage: U(2500, 150), text: 'half the section built' }]);

  const out = run('status-pre', approve('126066', { transcript_path: main }), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(injected(out).usage.total_tokens, 2650);
  assert.deepEqual(injected(out).source.agent_ids, ['abc123'], 'keyed by the agent id from the file name');
});

test('a round found twice — by discovery and by the stop hook — is counted once', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const main = path.join(d, 'sess-2.jsonl');
  fs.writeFileSync(main, '');
  const sub = path.join(d, 'sess-2', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const f = transcript(sub, 'agent-zz.jsonl', '700', [{ id: 'm1', usage: U(100, 10), text: 'ok\nRESULT: DONE' }]);

  run('sweep', { hook_event_name: 'Stop', transcript_path: main }, env);       // discovered
  run('record-usage', stop(f, 'zz', 'ok\nRESULT: DONE'), env);                  // same agent id
  run('record-usage', stop(f, 'other-key', 'ok\nRESULT: DONE'), env);           // same file, other key
  assert.equal(Object.keys(record(d, '700').rounds).length, 1, 'one transcript is one round');
  assert.equal(injected(run('status-pre', complete('700'), env)).usage.total_tokens, 110);
});

test('closing straight after stopping: a just-stopped round is not "still running"', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d, DESKLOG_ROUND_STALE_MS: '600000' };
  const f = transcript(d, 'r.jsonl', '701', [{ id: 'm1', usage: U(900, 90), text: 'partway' }]);
  run('round-start', start(f, 'a1', '701'), env);
  // without approval: Claude is told to ask the user
  assert.match(run('status-pre', complete('701'), env).hookSpecificOutput.permissionDecisionReason, /ASK THE USER/);
  // with approval: closed now, with what it spent
  const out = run('status-pre', approve('701'), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(injected(out).usage.total_tokens, 990);
  assert.equal(roundsOf(d, '701')[0].status, 'interrupted');
});

test('every hook leaves a line in the diagnostic log', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 'r.jsonl', '702', [{ id: 'm1', usage: U(1, 1), text: 'x' }]);
  run('round-start', start(f, 'a1', '702'), env);
  run('sweep', { hook_event_name: 'Stop' }, env);
  const log = fs.readFileSync(path.join(d, 'state', 'hook-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(log.some((l) => l.event === 'SubagentStart' && l.task_id === '702' && l.action === 'registered'));
  assert.ok(log.some((l) => l.event === 'Stop'));
  assert.ok(log.every((l) => !JSON.stringify(l).includes('exploring')), 'facts only, never content');
});


// ---------------------------------------------------------------- the 126075 bug
// The worker finished and said RESULT: DONE — but inside a hand-back TOOL CALL, not plain
// text. The plugin missed it, recorded "ended without a result", and the user was asked
// whether to close an unfinished task that was in fact finished.

function handbackTranscript(dir, file, taskId, handback, lastText) {
  const lines = [
    { type: 'user', message: { role: 'user', content: `DESKLOG_TASK_ID: ${taskId}\nDo the work.` } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Working on it.' }], usage: U(1000, 100) } },
    { type: 'assistant', message: { id: 'm2', usage: U(200, 300),
      content: [{ type: 'tool_use', name: 'SubagentHandback', input: { message: handback } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'Report delivered to your caller.' }] } },
  ];
  if (lastText) lines.push({ type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: lastText }], usage: U(10, 5) } });
  const f = path.join(dir, file);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

test('RESULT: DONE inside a hand-back tool call is a clean finish — no question asked', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = handbackTranscript(d, 'h.jsonl', '126075', 'Glassmorphism done across the store.\n\nRESULT: DONE');
  run('round-start', start(f, 'a1', '126075'), env);
  run('record-usage', stop(f, 'a1', ''), env);           // the hook saw no final text at all
  assert.equal(roundsOf(d, '126075')[0].status, 'completed');

  const out = run('status-pre', complete('126075'), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow', 'a finished task completes on the user\'s yes');
  assert.equal(injected(out).usage_complete, true, 'and it is reported as a clean finish');
});

test('a hand-back followed by a short closing text still counts as DONE', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = handbackTranscript(d, 'h.jsonl', '126076', 'All done.\nRESULT: DONE', 'Report sent.');
  run('round-start', start(f, 'a1', '126076'), env);
  run('record-usage', stop(f, 'a1', 'Report sent.'), env);
  assert.equal(roundsOf(d, '126076')[0].status, 'completed');
});

test('a hand-back that says FAILED is recorded as failed, not finished', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = handbackTranscript(d, 'h.jsonl', '126077', 'Build breaks on Safari.\nRESULT: FAILED');
  run('round-start', start(f, 'a1', '126077'), env);
  run('record-usage', stop(f, 'a1', ''), env);
  assert.equal(roundsOf(d, '126077')[0].status, 'failed');
  assert.equal(run('status-pre', complete('126077'), env).hookSpecificOutput.permissionDecision, 'deny');
});

test('a worker that really stopped without a RESULT line still needs the question', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 'r.jsonl', '126078', [{ id: 'm1', usage: U(100, 10), text: 'I got halfway.' }]);
  run('round-start', start(f, 'a1', '126078'), env);
  run('record-usage', stop(f, 'a1', 'I got halfway.'), env);
  const out = run('status-pre', complete('126078'), env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /ASK THE USER/);
});
