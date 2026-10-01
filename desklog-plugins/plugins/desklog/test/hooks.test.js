// Deterministic tests: no network, no model, no Claude Code. Run with:  node --test test/
// They prove the hook scripts and the plugin files behave as specified. They do NOT
// prove OAuth, the real MCP tools, real subagents or Desklog's server rules — see
// E2E_CHECKLIST.md for those.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const S = (name) => path.join(ROOT, 'scripts', name);
const STATUS = 'mcp__plugin_desklog_desklog__change_task_status';

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'desklog-test-')); }

// Exactly how Claude Code invokes them: node <plugin>/scripts/hook.js <name>
function run(script, input, env) {
  const r = spawnSync('node', [S('hook.js'), script.replace(/\.js$/, '')], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, DESKLOG_TRANSCRIPT_WAIT_MS: '200', ...env },
  });
  assert.equal(r.status, 0, `${script} must always exit 0 (stderr: ${r.stderr})`);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

// Build a worker transcript. messages: [{id, usage, text}]; duplicates allowed (streaming).
function transcript(dir, name, taskId, messages) {
  const lines = [];
  if (taskId) lines.push({ type: 'user', message: { role: 'user', content: `DESKLOG_TASK_ID: ${taskId}\nBuild the login page.` } });
  for (const m of messages) {
    const entry = { type: 'assistant', message: { id: m.id, content: [{ type: 'text', text: m.text || '' }], usage: m.usage } };
    if (m.at) entry.timestamp = m.at;
    lines.push(entry);
  }
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
}

const U = (i, o, cw, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr });

function stop(file, agentId, last, extra = {}) {
  return { hook_event_name: 'SubagentStop', session_id: 'sess-1', agent_id: agentId,
           agent_type: 'desklog:task-worker', agent_transcript_path: file, last_assistant_message: last, ...extra };
}

function record(dataDir, taskId) {
  const f = path.join(dataDir, 'usage', `${taskId}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

const setStatus = (taskId, status, extra = {}) =>
  ({ hook_event_name: 'PreToolUse', session_id: 'sess-1', tool_name: STATUS, tool_input: { task_id: taskId, status, ...extra } });
const pre = (taskId, extra = {}) => setStatus(taskId, 'Completed', extra);
const post = (taskId, status) => ({ ...setStatus(taskId, status), hook_event_name: 'PostToolUse', tool_response: { content: [{ type: 'text', text: 'ok' }] } });
const usageOf = (out) => out.hookSpecificOutput.updatedInput.ai_usage;

// ---------------------------------------------------------------- usage measurement

test('one round: streaming duplicates of a message are counted once', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [
    { id: 'm1', usage: U(1200, 40, 3000, 0), text: 'Looking.' },
    { id: 'm1', usage: U(1200, 95, 3000, 0) },                 // same message, final usage
    { id: 'm2', usage: U(300, 120, 0, 4200), text: 'Done.\nRESULT: DONE' },
  ]);
  run('record-usage.js', stop(f, 'a1', 'Done.\nRESULT: DONE'), env);
  const r = record(d, '101');
  assert.deepEqual(r.rounds.a1.usage,
    { input_tokens: 1500, output_tokens: 215, cache_creation_input_tokens: 3000, cache_read_input_tokens: 4200, total_tokens: 8915, api_calls: 2 });
  assert.equal(r.rounds.a1.result, 'done');
  assert.equal(r.rounds.a1.usage_complete, true);
});

test('continuation: three rounds of the same task accumulate into one total', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const rounds = [['a1', U(100, 10, 0, 0)], ['a2', U(200, 20, 0, 0)], ['a3', U(300, 30, 0, 0)]];
  for (const [agent, usage] of rounds) {
    const f = transcript(d, `${agent}.jsonl`, '101', [{ id: `${agent}-m`, usage, text: 'ok\nRESULT: DONE' }]);
    run('record-usage.js', stop(f, agent, 'ok\nRESULT: DONE'), env);
  }
  const out = run('status-pre.js', pre('101'), env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'allow');
  assert.equal(out.updatedInput.ai_usage.usage.input_tokens, 600);
  assert.equal(out.updatedInput.ai_usage.usage.output_tokens, 60);
  assert.equal(out.updatedInput.ai_usage.usage.total_tokens, 660);
  assert.equal(out.updatedInput.ai_usage.usage.api_calls, 3);
  assert.equal(out.updatedInput.ai_usage.source.rounds, 3);
});

test('the same round reported twice is not double-counted', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  const out = run('status-pre.js', pre('101'), env).hookSpecificOutput;
  assert.equal(out.updatedInput.ai_usage.usage.total_tokens, 110);
  assert.equal(out.updatedInput.ai_usage.source.rounds, 1);
});

test('a subagent without DESKLOG_TASK_ID is ignored silently', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', null, [{ id: 'm1', usage: U(1, 1, 0, 0), text: 'hi' }]);
  const out = run('record-usage.js', stop(f, 'a1', 'hi'), env);
  assert.equal(out, null);
  assert.equal(fs.existsSync(path.join(d, 'usage')), false);
});

test('transcript lag: waits for the final message, and flags usage_complete=false if it never arrives', async () => {
  const d = tmpDir();
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'working' }]);
  const finalLine = JSON.stringify({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'ok\nRESULT: DONE' }], usage: U(50, 5, 0, 0) } });

  // Case 1: the final message lands 300 ms after the hook starts → counted, complete.
  await new Promise((resolve) => {
    const p = spawn('node', [S('record-usage.js')], { env: { ...process.env, DESKLOG_PLUGIN_DATA: d, DESKLOG_TRANSCRIPT_WAIT_MS: '3000' } });
    p.stdin.end(JSON.stringify(stop(f, 'a1', 'ok\nRESULT: DONE')));
    setTimeout(() => fs.appendFileSync(f, finalLine + '\n'), 300);
    p.on('close', resolve);
  });
  let r = record(d, '101');
  assert.equal(r.rounds.a1.usage.total_tokens, 165);
  assert.equal(r.rounds.a1.usage_complete, true);

  // Case 2: it never lands → recorded, but flagged incomplete.
  const d2 = tmpDir();
  const f2 = transcript(d2, 't.jsonl', '102', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'working' }]);
  run('record-usage.js', stop(f2, 'a1', 'ok\nRESULT: DONE'), { DESKLOG_PLUGIN_DATA: d2 });
  r = record(d2, '102');
  assert.equal(r.rounds.a1.usage_complete, false);
});


// ---------------------------------------------------------------- completion gate (change_task_status → Completed)

test('RESULT: DONE is only a candidate: the round is recorded, nothing is completed', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  assert.equal(run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env), null);
  assert.ok(record(d, '101'));
});

test('status → In Progress passes through untouched (no gate, no usage added)', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  assert.equal(run('status-pre.js', setStatus('101', 'In Progress'), env), null);
  assert.equal(run('status-pre.js', setStatus('101', 'in_progress'), env), null);
});

test('status → Completed with a missing RESULT line is refused', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'I stopped halfway.' }]);
  run('record-usage.js', stop(f, 'a1', 'I stopped halfway.'), env);
  const out = run('status-pre.js', pre('101'), env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /ASK THE USER which they want/);
});

test('status → Completed after RESULT: FAILED is refused', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'Tests fail.\nRESULT: FAILED' }]);
  run('record-usage.js', stop(f, 'a1', 'Tests fail.\nRESULT: FAILED'), env);
  assert.equal(run('status-pre.js', pre('101'), env).hookSpecificOutput.permissionDecision, 'deny');
});

test('status → Completed for a task with no measured work is refused', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  assert.equal(run('status-pre.js', pre('9999'), env).hookSpecificOutput.permissionDecision, 'deny');
});

test('status values are matched case-insensitively: "COMPLETED", "done", "Closed" all trigger the gate', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  for (const v of ['COMPLETED', 'done', 'Closed']) {
    assert.equal(run('status-pre.js', setStatus('9999', v), env).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('user said NO, testing found a bug, later round DONE → completion allowed with ALL rounds counted', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f1 = transcript(d, 'r1.jsonl', '101', [{ id: 'r1', usage: U(100, 10, 0, 0), text: 'Built.\nRESULT: DONE' }]);
  run('record-usage.js', stop(f1, 'a1', 'Built.\nRESULT: DONE'), env);
  const f2 = transcript(d, 'r2.jsonl', '101', [{ id: 'r2', usage: U(50, 5, 0, 0), text: 'Could not reproduce.\nRESULT: FAILED' }]);
  run('record-usage.js', stop(f2, 'a2', 'Could not reproduce.\nRESULT: FAILED'), env);
  assert.equal(run('status-pre.js', pre('101'), env).hookSpecificOutput.permissionDecision, 'deny');
  const f3 = transcript(d, 'r3.jsonl', '101', [{ id: 'r3', usage: U(70, 7, 0, 0), text: 'Fixed spacing.\nRESULT: DONE' }]);
  run('record-usage.js', stop(f3, 'a3', 'Fixed spacing.\nRESULT: DONE'), env);
  const out = run('status-pre.js', pre('101'), env);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(usageOf(out).usage.total_tokens, 242);
  assert.equal(usageOf(out).result, 'done');
  // the call keeps the model's own task id and status untouched
  assert.equal(out.hookSpecificOutput.updatedInput.task_id, '101');
  assert.equal(out.hookSpecificOutput.updatedInput.status, 'Completed');
});

test('usage the model tries to send is replaced with the measured figures', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  const out = run('status-pre.js', pre('101', { ai_usage: { usage: { total_tokens: 5 } } }), env);
  assert.equal(usageOf(out).usage.total_tokens, 110);
  assert.equal(usageOf(out).source.channel, 'claude_code');
});

test('completion_key is stable for the same rounds and changes when a round is added', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  const k1 = usageOf(run('status-pre.js', pre('101'), env)).source.completion_key;
  assert.equal(usageOf(run('status-pre.js', pre('101'), env)).source.completion_key, k1);
  const f2 = transcript(d, 't2.jsonl', '101', [{ id: 'm2', usage: U(1, 1, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f2, 'a2', 'ok\nRESULT: DONE'), env);
  assert.notEqual(usageOf(run('status-pre.js', pre('101'), env)).source.completion_key, k1);
});

// ---------------------------------------------------------------- after Desklog accepts (PostToolUse)

test('In Progress accepted → task remembered as running; Completed accepted → forgotten, ledger written, record cleared', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  run('status-post.js', post('101', 'In Progress'), env);
  let active = JSON.parse(fs.readFileSync(path.join(d, 'state', 'active-tasks.json'), 'utf8'));
  assert.ok(active['101']);

  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  run('status-post.js', post('101', 'Completed'), env);

  active = JSON.parse(fs.readFileSync(path.join(d, 'state', 'active-tasks.json'), 'utf8'));
  assert.equal(active['101'], undefined);
  assert.equal(record(d, '101'), null);
  const ledger = fs.readFileSync(path.join(d, 'completed-tasks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].task_id, '101');
  assert.equal(ledger[0].usage.total_tokens, 110);
});

test('Desklog unreachable → PostToolUse never runs → record kept → retry sends identical data', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  const first = usageOf(run('status-pre.js', pre('101'), env));
  assert.ok(record(d, '101'));
  assert.deepEqual(usageOf(run('status-pre.js', pre('101'), env)), first);
});

test('a workflow with two completion steps (Done → Completed) sends the same figures again, same key', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);

  const first = usageOf(run('status-pre.js', setStatus('101', 'Done'), env));
  run('status-post.js', post('101', 'Done'), env);          // Desklog accepted → record cleared
  assert.equal(record(d, '101'), null);

  const second = run('status-pre.js', setStatus('101', 'Completed'), env).hookSpecificOutput;
  assert.equal(second.permissionDecision, 'allow', 'the QA step must not be refused');
  assert.equal(second.updatedInput.ai_usage.usage.total_tokens, first.usage.total_tokens);
  assert.equal(second.updatedInput.ai_usage.source.completion_key, first.source.completion_key);
});

test('a task never worked on here is still refused', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  assert.equal(run('status-pre.js', setStatus('555', 'Completed'), env).hookSpecificOutput.permissionDecision, 'deny');
});

test('claude_seconds: measured from the transcript timestamps, summed over rounds, null without them', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f1 = transcript(d, 'r1.jsonl', '101', [
    { id: 'a', usage: U(10, 1, 0, 0), text: 'start', at: '2026-09-23T08:00:00Z' },
    { id: 'b', usage: U(10, 1, 0, 0), text: 'ok\nRESULT: DONE', at: '2026-09-23T08:02:00Z' }]);
  run('record-usage.js', stop(f1, 'a1', 'ok\nRESULT: DONE'), env);
  const f2 = transcript(d, 'r2.jsonl', '101', [
    { id: 'c', usage: U(10, 1, 0, 0), text: 'start', at: '2026-09-23T08:10:00Z' },
    { id: 'e', usage: U(10, 1, 0, 0), text: 'ok\nRESULT: DONE', at: '2026-09-23T08:10:30Z' }]);
  run('record-usage.js', stop(f2, 'a2', 'ok\nRESULT: DONE'), env);
  assert.equal(usageOf(run('status-pre.js', pre('101'), env)).claude_seconds, 150); // 120 + 30

  const d2 = tmpDir(), env2 = { DESKLOG_PLUGIN_DATA: d2 };
  const f3 = transcript(d2, 't.jsonl', '102', [{ id: 'a', usage: U(10, 1, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f3, 'a1', 'ok\nRESULT: DONE'), env2);
  assert.equal(usageOf(run('status-pre.js', pre('102'), env2)).claude_seconds, null);
});

test('no prose is sent to Desklog: only measured fields', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const wordy = 'I rewrote the button styles and checked contrast.'.repeat(40) + '\nRESULT: DONE';
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: wordy }]);
  run('record-usage.js', stop(f, 'a1', wordy), env);
  const p = usageOf(run('status-pre.js', pre('101'), env));
  assert.deepEqual(Object.keys(p).sort(),
    ['claude_seconds', 'result', 'source', 'usage', 'usage_complete'].sort());
  assert.doesNotMatch(JSON.stringify(p), /rewrote the button styles/);
});

test('a long task sends at most the server-kept number of agent ids, but the true round count', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'desklog.config.json'), 'utf8')).usage.max_agent_ids;
  for (let i = 1; i <= cap + 5; i++) {
    const f = transcript(d, `r${i}.jsonl`, '101', [{ id: `m${i}`, usage: U(1, 1, 0, 0), text: 'ok\nRESULT: DONE' }]);
    run('record-usage.js', stop(f, `agent-${i}`, 'ok\nRESULT: DONE'), env);
  }
  const p = usageOf(run('status-pre.js', pre('101'), env));
  assert.equal(p.source.agent_ids.length, cap);
  assert.equal(p.source.rounds, cap + 5, 'the true number of rounds is still reported');
  assert.equal(p.usage.total_tokens, (cap + 5) * 2, 'every round is still counted');
  assert.ok(p.source.agent_ids.includes(`agent-${cap + 5}`), 'the most recent rounds are the ones sent');
});

test('records live outside the plugin folder, so an upgrade cannot delete them', () => {
  const cfgDir = JSON.parse(fs.readFileSync(path.join(ROOT, 'desklog.config.json'), 'utf8')).data_dir;
  assert.ok(cfgDir && !/CLAUDE_PLUGIN_DATA/.test(cfgDir), 'a stable data_dir must be configured');

  // the configured folder wins over CLAUDE_PLUGIN_DATA (which an upgrade deletes)
  const home = tmpDir(), pluginOnly = tmpDir();
  const f0 = transcript(home, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f0, 'a1', 'ok\nRESULT: DONE'), { HOME: home, CLAUDE_PLUGIN_DATA: pluginOnly });
  const configured = path.join(home, cfgDir.replace(/^~\/?/, ''), 'usage', '101.json');
  assert.ok(fs.existsSync(configured), `expected the record in the configured folder (${configured})`);
  assert.equal(fs.existsSync(path.join(pluginOnly, 'usage', '101.json')), false, 'not in the plugin folder');

  // DESKLOG_PLUGIN_DATA wins over CLAUDE_PLUGIN_DATA
  const stable = tmpDir(), pluginDir = tmpDir();
  const env = { DESKLOG_PLUGIN_DATA: stable, CLAUDE_PLUGIN_DATA: pluginDir };
  const f = transcript(stable, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  assert.ok(fs.existsSync(path.join(stable, 'usage', '101.json')), 'written to the stable folder');
  assert.equal(fs.existsSync(path.join(pluginDir, 'usage', '101.json')), false, 'not in the plugin folder');
  assert.equal(run('status-pre.js', pre('101'), env).hookSpecificOutput.permissionDecision, 'allow');
});

test('pausing frees the bot but keeps the task measurable for later', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(100, 10, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f, 'a1', 'ok\nRESULT: DONE'), env);
  run('status-post.js', post('101', 'In Progress'), env);
  run('status-post.js', post('101', 'Pause'), env);

  const active = JSON.parse(fs.readFileSync(path.join(d, 'state', 'active-tasks.json'), 'utf8'));
  assert.equal(active['101'], undefined, 'a paused task must not count as running');
  assert.ok(record(d, '101'), 'its measured rounds must survive the pause');

  // resumed later, another round, then completed: both rounds are reported
  const f2 = transcript(d, 't2.jsonl', '101', [{ id: 'm2', usage: U(50, 5, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', stop(f2, 'a2', 'ok\nRESULT: DONE'), env);
  const out = usageOf(run('status-pre.js', pre('101'), env));
  assert.equal(out.usage.total_tokens, 165);
  assert.equal(out.source.rounds, 2);
});

// ---------------------------------------------------------------- own bot (get_my_bot_users + create_task)

const bots = (session, response) => ({ hook_event_name: 'PostToolUse', session_id: session,
  tool_name: 'mcp__plugin_desklog_desklog__get_my_bot_users', tool_response: response });
const create = (session, input) => ({ hook_event_name: 'PreToolUse', session_id: session,
  tool_name: 'mcp__plugin_desklog_desklog__create_task', tool_input: input });

test('get_my_bot_users: bot ids are read from the MCP reply, whatever its shape', () => {
  const shapes = [
    { content: [{ type: 'text', text: JSON.stringify({ bots: [{ id: 41, name: "John's bot" }] }) }] },
    [{ type: 'text', text: JSON.stringify([{ bot_user_id: 41 }]) }],
    JSON.stringify({ data: { user_id: 41 } }),
  ];
  for (const resp of shapes) {
    const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
    run('bots-post.js', bots('s1', resp), env);
    const saved = JSON.parse(fs.readFileSync(path.join(d, 'state', 'my-bots-s1.json'), 'utf8'));
    assert.deepEqual(saved.ids, ['41']);
  }
});

test('get_my_bot_users with open_tasks: only the bot id is remembered, never task ids', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const reply = { status: true, total_bot_users: 1, by_team: [{ team: 'RD 2', bot_count: 1 }],
    bot_users: [{ user_id: 336, name: 'Adwaidh M P - bot', team: null,
      open_tasks: [{ id: 116357, task_title: 'Add search', current_status: 'TO DO' },
                   { id: 117307, task_title: 'chart issue', current_status: 'TO DO' }],
      open_tasks_has_more: false }] };
  run('bots-post.js', bots('s1', { content: [{ type: 'text', text: JSON.stringify(reply) }] }), env);
  const saved = JSON.parse(fs.readFileSync(path.join(d, 'state', 'my-bots-s1.json'), 'utf8'));
  assert.deepEqual(saved.ids, ['336']);
  assert.match(run('create-guard.js', create('s1', { title: 'A', assignee_id: 336 }), env).systemMessage, /hooks active/);
  assert.equal(run('create-guard.js', create('s1', { title: 'A', assignee_id: 116357 }), env).hookSpecificOutput.permissionDecision, 'deny');
});

test('get_my_bot_users: Claude is told which tasks were started here and are still running', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  let ctx = run('bots-post.js', bots('s1', { content: [] }), env).hookSpecificOutput.additionalContext;
  assert.match(ctx, /no task started from this computer is still running/);
  run('status-post.js', post('100', 'In Progress'), env);
  ctx = run('bots-post.js', bots('s1', { content: [] }), env).hookSpecificOutput.additionalContext;
  assert.match(ctx, /#100/);
  assert.match(ctx, /busy/);
});

test('create_task: own bot allowed, any other assignee refused, no lookup yet refused, no assignee allowed', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  // before get_my_bot_users in this session
  let out = run('create-guard.js', create('s1', { title: 'A', assignee_id: 41 }), env).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /get_my_bot_users first/);

  run('bots-post.js', bots('s1', { content: [{ type: 'text', text: JSON.stringify({ id: 41 }) }] }), env);
  assert.match(run('create-guard.js', create('s1', { title: 'A', assignee_id: 41 }), env).systemMessage, /hooks active/);
  assert.match(run('create-guard.js', create('s1', { title: 'A', assignees: [41] }), env).systemMessage, /hooks active/);

  for (const input of [{ title: 'A', assignee_id: 7 }, { title: 'A', assignees: [41, 7] }, { title: 'A', meta: { bot_user_id: 7 } }]) {
    out = run('create-guard.js', create('s1', input), env).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny');
    assert.match(out.permissionDecisionReason, /your own bot/);
  }
  // another session has not looked up its bot yet
  assert.equal(run('create-guard.js', create('s2', { title: 'A', assignee_id: 41 }), env).hookSpecificOutput.permissionDecision, 'deny');
  // no assignee field: Desklog decides
  assert.match(run('create-guard.js', create('s1', { title: 'A', description: 'x' }), env).systemMessage, /hooks active/);
});

// ---------------------------------------------------------------- hooks must actually run

test('hooks.json names one command per hook, and it works on every OS', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
  const names = [];
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) {
    assert.equal(h.args, undefined, 'shell form only: exec form cannot find node.cmd shims on Windows');
    // A bare .sh or .cmd path breaks on Windows (file association / no shell).
    assert.doesNotMatch(h.command, /\.(sh|cmd|bat|ps1)\b/, `${h.command} is not cross-platform`);
    assert.match(h.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hook\.js" [a-z-]+$/,
      `${h.command} must be: node "<root>/scripts/hook.js" <name>`);
    names.push(h.command.split('" ')[1]);
  }
  // the path is quoted, so a plugin folder with spaces still works
  assert.ok(names.length >= 5);
  for (const n of names) {
    const r = spawnSync('node', [S('hook.js'), n], { input: '{}', encoding: 'utf8',
      env: { ...process.env, DESKLOG_PLUGIN_DATA: tmpDir() } });
    assert.equal(r.status, 0, `hook ${n} must exit 0 (stderr: ${r.stderr})`);
  }
});

test('an unknown hook name is reported but never fails the tool call', () => {
  const r = spawnSync('node', [S('hook.js'), 'no-such-hook'], { input: '{}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /unknown hook/);
});

test('no shell wrappers are left behind for a hook to depend on', () => {
  for (const f of ['scripts/run-node.cmd', 'hooks/hooks-windows.json']) {
    assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} should be gone: one file serves every OS now`);
  }
});

test('creating a task reports that the hooks are alive', () => {
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  run('bots-post.js', bots('s1', { content: [{ type: 'text', text: JSON.stringify({ id: 41 }) }] }), env);
  const out = run('create-guard.js', create('s1', { title: 'A', assignee_id: 41 }), env);
  assert.match(out.systemMessage, /hooks active/);
});

test('SubagentStop runs for every subagent, so a differently-named worker is still measured', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
  for (const g of hooks.SubagentStop) {
    assert.ok(!g.matcher || g.matcher === '*' || g.matcher === '.*',
      'SubagentStop must not be limited to one agent name — record-usage ignores non-Desklog subagents itself');
  }
  const d = tmpDir(), env = { DESKLOG_PLUGIN_DATA: d };
  const f = transcript(d, 't.jsonl', '101', [{ id: 'm1', usage: U(5, 5, 0, 0), text: 'ok\nRESULT: DONE' }]);
  run('record-usage.js', { ...stop(f, 'a1', 'ok\nRESULT: DONE'), agent_type: 'general-purpose' }, env);
  assert.ok(record(d, '101'), 'measured regardless of the agent name');
});

test('check-env reports what the plugin needs, and nothing else', () => {
  const d = tmpDir();
  const out = JSON.parse(spawnSync('node', [S('hook.js'), 'check-env'],
    { encoding: 'utf8', env: { ...process.env, DESKLOG_PLUGIN_DATA: d } }).stdout);
  assert.equal(out.data_dir, d);
  assert.equal(out.data_dir_writable, true);
  assert.equal(out.config_readable, true);
  assert.equal(out.node.supported, true);
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(d), 'it may create its own data folder, but nothing else');
});

test('the check skill never installs anything', () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills/check/SKILL.md'), 'utf8');
  assert.match(skill, /Do not install anything, ever/);
  assert.match(skill, /Never run an installer yourself/);
  assert.match(skill, /node: not found/);
});

// ---------------------------------------------------------------- plugin files

test('plugin files: OAuth only, real tool names, hooks point at real scripts', () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.userConfig, undefined, 'no token prompt — OAuth only');
  const mcp = JSON.parse(read('.mcp.json'));
  assert.equal(mcp.mcpServers.desklog.headers, undefined, 'no Authorization header — OAuth only');
  JSON.parse(read('desklog.config.json'));

  const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
  const matchers = [];
  for (const groups of Object.values(hooks)) for (const g of groups) {
    matchers.push(g.matcher);
    for (const h of g.hooks) {
      const script = h.command.replace('${CLAUDE_PLUGIN_ROOT}', ROOT).match(/"([^"]+)"/)[1];
      assert.ok(fs.existsSync(script), script);
    }
  }
  for (const tool of ['change_task_status', 'create_task', 'get_my_bot_users']) {
    assert.ok(matchers.some((m) => m && m.includes(`__${tool}$`)), `no hook for ${tool}`);
  }

  const skills = read('skills/run/SKILL.md') + read('skills/status/SKILL.md') + read('agents/task-worker.md');
  assert.match(skills, /open_tasks/);
  assert.match(skills, /ai_usage/);
  assert.match(skills, /was NOT recorded/);
  assert.match(skills, /start the first new task straight away/);
  assert.match(skills, /is a PROPOSAL/);
  assert.match(read('skills/run/SKILL.md'), /Mark it Done now/);
  assert.match(read('skills/run/SKILL.md'), /THE CODE TO CHANGE IS IN THE CURRENT WORKING DIRECTORY/);
  assert.match(read('skills/run/SKILL.md'), /WORKING DIRECTORY: <the current working directory/);
  assert.match(read('skills/run/SKILL.md'), /Do not add your own guesses about what the project is/);
  assert.match(read('agents/task-worker.md'), /That folder IS the project/);
  assert.match(read('skills/run/SKILL.md'), /NEVER ASK which folder or codebase to use/);
  assert.match(read('agents/task-worker.md'), /not existing yet is normal/);
  assert.match(read('agents/task-worker.md'), /Do not list, search or open\s+sibling folders/);
  assert.match(read('skills/run/SKILL.md'), /A `\/desklog(-dev)?:run` request is NEW WORK by default/);
  assert.match(read('skills/run/SKILL.md'), /Do not ask a question whose answer you\s+would suggest yourself/);
  assert.match(read('skills/run/SKILL.md'), /not to\s+a fresh `\/desklog(-dev)?:run`/);
  assert.match(read('skills/run/SKILL.md'), /<p><strong>Completion note<\/strong><\/p>/);
  assert.match(read('skills/run/SKILL.md'), /APPEND, never replace/);
  assert.match(read('skills/run/SKILL.md'), /Never add that flag on your own initiative/);
  // the description is rendered as HTML by Desklog, and must never carry secrets
  assert.match(read('skills/run/SKILL.md'), /<p><strong>What was asked<\/strong><\/p>/);
  assert.match(read('skills/run/SKILL.md'), /NEVER put secrets in a task/);
  assert.match(read('skills/run/SKILL.md'), /\(password shared separately\)/);
  // the web timer's auto-start is browser-side only, so calling it over MCP does nothing
  assert.match(read('skills/run/SKILL.md'), /do\s+NOT call `start_timer`/);
  assert.doesNotMatch(read('skills/run/SKILL.md'), /Then call `start_timer`/);
  assert.match(skills, /ASK WITH THE `AskUserQuestion` TOOL/);
  assert.match(skills, /ENDS YOUR TURN/);
  assert.match(skills, /ASK FIRST — do not assume/);
  assert.match(skills, /Should this go on Task #<id>/);
  assert.match(skills, /Do not\s+set the task In Progress, start the timer or launch a worker until this is settled/);
  assert.match(skills, /ASK THIS FIRST, ON ITS OWN/);
  assert.match(skills, /ONLY AFTER THE PROJECT IS SETTLED/);
  assert.match(skills, /EVERY Ongoing project/);
  assert.match(skills, /PARTIAL name/);
  assert.match(skills, /Desklog's own status filter is not\s+reliable/);
  assert.match(skills, /Do not ask this through `AskUserQuestion`/);
  assert.match(skills, /used word for word/);
  assert.match(skills, /Never create the task while this question is unanswered/);
  assert.match(skills, /the title agreed in Step 3c/);
  assert.match(skills, /set the task to Pause/);
  assert.match(skills, /the task stays PAUSED/);
  assert.match(skills, /Set the task back to In Progress/);
  assert.match(skills, /Complete it straight from Pause/);
  assert.match(skills, /Never start\s+one of the bot's older waiting tasks without asking/);
  assert.match(skills, /Repetition is not permission/);
  assert.match(skills, /USER'S OWN projects/);
  assert.match(skills, /Never call any tool that\s+creates a project/);
  for (const tool of ['get_my_bot_users', 'get_project_list', 'get_task_list', 'create_task', 'change_task_status', 'get_task_details']) {
    assert.match(skills, new RegExp(tool));
  }
  assert.doesNotMatch(skills, /find_free_bot|create_and_assign_tasks|complete_task|`start_task`|`get_my_bot`/);
  assert.match(skills, /Never fetch the task\s+list unfiltered/);
  for (const rule of [/OWN bot/, /Should I pause it and start/, /Never mark a task complete without an explicit yes/,
                      /Never create a new Desklog task for it/, /Never poll/, /CANDIDATE completion/, /DESKLOG_TASK_ID/]) {
    assert.match(skills, rule);
  }
});

test('hook matchers: dev plugin also catches a hand-added "desklog" server; live plugin does not', () => {
  const name = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).name;
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
  const toolMatchers = [...hooks.PreToolUse, ...hooks.PostToolUse].map((g) => new RegExp(g.matcher));
  for (const tool of ['change_task_status', 'create_task', 'get_my_bot_users']) {
    const own = name === 'desklog-dev' ? `mcp__plugin_desklog-dev_desklog__${tool}` : `mcp__plugin_desklog_desklog__${tool}`;
    assert.ok(toolMatchers.some((m) => m.test(own)), `${name}: no hook for its own ${tool}`);
    const handAdded = `mcp__desklog__${tool}`;
    assert.equal(toolMatchers.some((m) => m.test(handAdded)), name === 'desklog-dev', `${name}: hand-added server handling for ${tool}`);
  }
  assert.ok(!toolMatchers.some((m) => m.test('mcp__desklog__get_task_list')), 'no hook on unrelated tools');
});
