// Shared helpers for the Desklog hooks. No network calls anywhere: everything that
// reaches Desklog goes through the logged-in (OAuth) MCP connection.
// Field names and status values come from ../desklog.config.json.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'desklog.config.json'), 'utf8'));

// Records live OUTSIDE the plugin folder by default: CLAUDE_PLUGIN_DATA belongs to one
// installed version and is removed when the plugin is uninstalled or upgraded, which
// would take an in-progress task's measurements with it.
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const baseDir = () => expand(process.env.DESKLOG_PLUGIN_DATA)
  || expand(CONFIG.data_dir)
  || process.env.CLAUDE_PLUGIN_DATA
  || path.join(os.tmpdir(), 'desklog-plugin');
const dataDir = () => path.join(baseDir(), 'usage');
const stateDir = () => path.join(baseDir(), 'state');
const safe = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const usageFile = (taskId) => path.join(dataDir(), `${safe(taskId)}.json`);

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}
function readJson(f, fallback) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
}
// Write to a temp file then rename, so a crash never leaves a half-written file.
function writeJson(f, value) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, f);
}
function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

// ---- tool inputs ------------------------------------------------------------
const lc = (s) => String(s).toLowerCase();

// First field whose name is in `names` — top level first, then one level down.
function findField(obj, names) {
  if (!obj || typeof obj !== 'object') return null;
  const wanted = names.map(lc);
  for (const [k, v] of Object.entries(obj)) if (wanted.includes(lc(k))) return { key: k, value: v };
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, w] of Object.entries(v)) if (wanted.includes(lc(k))) return { key: k, value: w };
    }
  }
  return null;
}

// Every value of every field (at any depth) whose name is in `names`.
function findAllValues(obj, names) {
  const wanted = names.map(lc); const out = [];
  (function walk(v) {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, w] of Object.entries(v)) {
        if (wanted.includes(lc(k))) [].concat(w).forEach((x) => { if (x !== null && x !== undefined && typeof x !== 'object') out.push(String(x)); });
        else walk(w);
      }
    }
  })(obj);
  return out;
}

// 'in_progress' | 'completed' | 'paused' | 'other'
function classifyStatus(value) {
  const v = lc(value).trim();
  const s = CONFIG.status_values;
  if (s.completed.map(lc).includes(v)) return 'completed';
  if (s.in_progress.map(lc).includes(v)) return 'in_progress';
  if ((s.paused || []).map(lc).includes(v)) return 'paused';
  return 'other';
}

const statusChange = (toolInput) => {
  const st = findField(toolInput, CONFIG.fields.status);
  const id = findField(toolInput, CONFIG.fields.task_id);
  return { kind: st ? classifyStatus(st.value) : 'other', taskId: id ? String(id.value) : null };
};

// MCP tool responses arrive in several shapes; collect every JSON object inside.
function responseObjects(resp) {
  const found = [];
  (function walk(v) {
    if (typeof v === 'string') { try { walk(JSON.parse(v)); } catch { /* plain text */ } return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') { found.push(v); Object.values(v).forEach(walk); }
  })(resp);
  return found;
}

// ---- usage records ----------------------------------------------------------
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
function emptyUsage() { const u = {}; USAGE_KEYS.forEach((k) => { u[k] = 0; }); u.total_tokens = 0; u.api_calls = 0; return u; }
function addUsage(a, b) {
  const u = { ...a };
  USAGE_KEYS.forEach((k) => { u[k] += Number(b[k] || 0); });
  u.api_calls += Number(b.api_calls || 0);
  u.total_tokens = USAGE_KEYS.reduce((s, k) => s + u[k], 0);
  return u;
}
// ---- measuring a round ------------------------------------------------------
// One place that reads a worker transcript, so a round can be measured at any moment:
// while it runs, when it ends, or long after it was interrupted.
const textOfEntry = (e) => (e && e.message ? textOf(e.message.content) : '');

function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === 'assistant') { const t = textOfEntry(entries[i]).trim(); if (t) return t; }
  }
  return '';
}

function taskIdFromEntries(entries) {
  for (const e of entries) {
    if (e.type !== 'user') continue;
    const m = textOfEntry(e).match(/^\s*DESKLOG_TASK_ID:\s*(\S+)/m);
    if (m) return m[1];
  }
  return null;
}

// Streaming writes several entries per API message; keep the LAST one per message id.
function usageOfEntries(entries) {
  const byId = new Map();
  entries.forEach((e, i) => {
    if (e.type === 'assistant' && e.message && e.message.usage) byId.set(e.message.id || `idx-${i}`, e.message.usage);
  });
  let u = emptyUsage();
  for (const x of byId.values()) u = addUsage(u, { ...x, api_calls: 1 });
  return u;
}

function secondsOfEntries(entries) {
  const times = entries.map((e) => Date.parse(e.timestamp || (e.message && e.message.timestamp) || ''))
                       .filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  return Math.max(0, Math.round((Math.max(...times) - Math.min(...times)) / 1000));
}

const resultOfText = (text) => {
  const m = (text || '').trim().match(/RESULT:\s*(DONE|FAILED)\s*$/i);
  return m ? m[1].toLowerCase() : null;
};

// Every string the worker itself wrote in one assistant entry: its text, AND the inputs of
// its tool calls. A worker may hand its report back through a tool (e.g. SubagentHandback,
// whose `message` ends with the RESULT line) instead of in plain text.
function stringsOfEntry(e) {
  const out = [];
  const content = e && e.message && e.message.content;
  if (typeof content === 'string') out.push(content);
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!b) continue;
      if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
      if (b.type === 'tool_use') (function walk(v) {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      })(b.input);
    }
  }
  return out;
}

// The worker's last RESULT line, wherever it wrote it — the final text or a hand-back
// tool call. Searched from the end, so a later FAILED overrides an earlier DONE.
function lastResultMarker(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== 'assistant') continue;
    const strings = stringsOfEntry(entries[i]);
    for (let j = strings.length - 1; j >= 0; j--) {
      const all = [...strings[j].matchAll(/RESULT:\s*(DONE|FAILED)\b/gi)];
      if (all.length) return all[all.length - 1][1].toLowerCase();
    }
  }
  return null;
}

// Measure whatever the transcript holds RIGHT NOW. Safe on a half-written transcript:
// a round cut off by a crash, a closed session or Ctrl-C still reports what it spent.
function measureTranscript(file) {
  const entries = readJsonl(file);
  const finalText = lastAssistantText(entries);
  return {
    exists: !!(file && fs.existsSync(file)),
    entries: entries.length,
    task_id: taskIdFromEntries(entries),
    usage: usageOfEntries(entries),
    seconds: secondsOfEntries(entries),
    result: resultOfText(finalText) || lastResultMarker(entries),
    final_text: finalText,
    mtime: (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })(),
  };
}

const loadRecord = (taskId) => readJson(usageFile(taskId), null);
const saveRecord = (record) => writeJson(usageFile(record.task_id), record);
const completionKey = (taskId, agentIds) =>
  crypto.createHash('sha256').update(`${taskId}|${[...agentIds].sort().join(',')}`).digest('hex').slice(0, 32);

// Add or update ONE round of a task. Keyed by agent id, so measuring the same round
// again replaces it and can never double-count.
function upsertRound(taskId, agentId, patch) {
  const now = new Date().toISOString();
  const record = loadRecord(taskId) || { task_id: String(taskId), rounds: {}, created_at: now };
  // One transcript is one round, however we came to know about it (start hook, stop hook
  // or discovery). If it is already recorded under another key, adopt that entry.
  if (!record.rounds[agentId] && patch.transcript_path) {
    const other = Object.keys(record.rounds).find((k) => record.rounds[k].transcript_path === patch.transcript_path);
    if (other) { record.rounds[agentId] = record.rounds[other]; delete record.rounds[other]; }
  }
  const prev = record.rounds[agentId];
  record.rounds[agentId] = {
    status: 'running',
    usage: emptyUsage(),
    usage_complete: false,
    seconds: null,
    result: null,
    ...prev,
    ...patch,
    order: prev ? prev.order : Object.keys(record.rounds).length + 1,
    updated_at: now,
  };
  if (patch.status && patch.status !== 'running') record.last_agent_id = agentId;
  record.updated_at = now;
  saveRecord(record);
  return record.rounds[agentId];
}

// A round that is still marked running long after its transcript stopped growing was
// interrupted — a connection drop, a closed window, Ctrl-C. Re-measure it, keep what it
// spent, and label it. Runs on session start/end and before any completion.
const STALE_MS = () => Number(process.env.DESKLOG_ROUND_STALE_MS || 120000);

function sweepRounds(reason) {
  const dir = dataDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const touched = [];
  for (const f of files) {
    const record = readJson(path.join(dir, f), null);
    if (!record || !record.rounds) continue;
    let changed = false;
    for (const [agentId, round] of Object.entries(record.rounds)) {
      if (round.status !== 'running') continue;
      const m = measureTranscript(round.transcript_path);
      // keep whatever it spent, however it ended
      round.usage = m.usage;
      round.seconds = m.seconds;
      if (m.result) round.result = m.result;
      const idle = Date.now() - (m.mtime || Date.parse(round.started_at || 0) || 0);
      if (reason === 'session-end') round.status = 'cancelled';
      else if (reason === 'user-closed') round.status = 'interrupted';
      else if (!m.exists || idle > STALE_MS()) round.status = 'interrupted';
      if (round.status !== 'running') { round.ended_as = reason || 'sweep'; record.last_agent_id = agentId; }
      round.updated_at = new Date().toISOString();
      changed = true;
    }
    if (changed) { saveRecord(record); touched.push(record.task_id); }
  }
  return touched;
}

// ---- finding rounds that were never registered --------------------------------
// The start hook may fire before the worker's transcript holds its task id, and the
// start event may not carry the prompt. So a round without a task id yet is parked here
// and resolved later, once its transcript says which task it belongs to.
const pendingFile = () => path.join(stateDir(), 'pending-rounds.json');

function addPending(agentId, info) {
  const pending = readJson(pendingFile(), {});
  pending[agentId] = { ...pending[agentId], ...info, parked_at: new Date().toISOString() };
  writeJson(pendingFile(), pending);
}

function resolvePending() {
  const pending = readJson(pendingFile(), {});
  let changed = false;
  for (const [agentId, info] of Object.entries(pending)) {
    const m = measureTranscript(info.transcript_path);
    if (m.task_id) {
      upsertRound(m.task_id, agentId, { status: 'running', transcript_path: info.transcript_path,
        session_id: info.session_id || null, started_at: info.started_at || info.parked_at,
        usage: m.usage, seconds: m.seconds });
      delete pending[agentId]; changed = true;
    } else if (Date.now() - Date.parse(info.parked_at || 0) > 24 * 3600 * 1000) {
      delete pending[agentId]; changed = true; // never became a Desklog round
    }
  }
  if (changed) writeJson(pendingFile(), pending);
}

// Last line of defence: look through this session's own folder for worker transcripts
// that carry a DESKLOG_TASK_ID and are not recorded yet. Needs no start hook at all.
function* jsonlFiles(dir, depth) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) yield* jsonlFiles(full, depth - 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

function discoverRounds(mainTranscriptPath) {
  if (!mainTranscriptPath) return [];
  const sessionDir = mainTranscriptPath.replace(/\.jsonl$/, '');
  const found = [];
  for (const file of jsonlFiles(sessionDir, 3)) {
    if (file === mainTranscriptPath) continue;
    const m = measureTranscript(file);
    if (!m.task_id) continue;
    const record = loadRecord(m.task_id);
    const known = record && Object.values(record.rounds).some((r) => r.transcript_path === file);
    if (known) continue;
    const id = (path.basename(file).match(/^agent-(.+)\.jsonl$/) || [])[1]
      || 'found-' + crypto.createHash('sha256').update(file).digest('hex').slice(0, 16);
    upsertRound(m.task_id, id, {
      status: m.result === 'done' ? 'completed' : m.result === 'failed' ? 'failed' : 'running',
      result: m.result, transcript_path: file, usage: m.usage, seconds: m.seconds,
      usage_complete: !!m.result, found_by: 'discovery',
    });
    found.push(m.task_id);
  }
  return found;
}

// Everything that might have been missed, in order: parked starts, then discovery.
function catchUp(input) {
  try { resolvePending(); } catch { /* best effort */ }
  try { discoverRounds(input && input.transcript_path); } catch { /* best effort */ }
}

// A short diagnostic trail: which hooks fired and what they could see. No content, only
// facts — enough to tell, on a real machine, why a round was or was not recorded.
const hookLogFile = () => path.join(stateDir(), 'hook-log.jsonl');
function logHook(entry) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(hookLogFile(), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    const lines = fs.readFileSync(hookLogFile(), 'utf8').split('\n').filter(Boolean);
    if (lines.length > 300) fs.writeFileSync(hookLogFile(), lines.slice(-200).join('\n') + '\n');
  } catch { /* never let logging break a hook */ }
}

// The most recent round of all, whatever became of it.
const latestRound = (record) =>
  Object.values(record.rounds).sort((a, b) => (a.order || 0) - (b.order || 0)).slice(-1)[0] || null;

// The most recent round that actually finished — interrupted rounds still count their
// tokens, but they never decide whether a task may be completed.
function latestFinishedRound(record) {
  const finished = Object.values(record.rounds)
    .filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'incomplete')
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  return finished[finished.length - 1] || null;
}

const hasRunningRound = (record) => Object.values(record.rounds).some((r) => r.status === 'running');

// Totals across every round of a task, ready to send.
function usagePayload(record) {
  const ids = Object.keys(record.rounds);
  // The server keeps only the first 50 agent ids. Send the most recent ones, so a long
  // task reports the rounds that matter; `rounds` still states the true total.
  const maxIds = Number(CONFIG.usage.max_agent_ids || 50);
  const sent = ids.length <= maxIds ? ids
    : [...ids].sort((a, b) => (record.rounds[a].order || 0) - (record.rounds[b].order || 0)).slice(-maxIds);
  const last = latestFinishedRound(record) || record.rounds[record.last_agent_id];
  const seconds = ids.map((id) => record.rounds[id].seconds).filter((x) => typeof x === 'number');
  // Only measured things are reported. The worker's prose stays in the conversation:
  // it was one round's wording, truncated, and a claim sitting among facts.
  return {
    result: last.result,
    // Time Claude spent working, summed over rounds. Desklog's own start/finish
    // timestamps remain the authority for how long the TASK took.
    claude_seconds: (CONFIG.usage.include_claude_seconds !== false && seconds.length) ? seconds.reduce((a, b) => a + b, 0) : null,
    usage: ids.reduce((u, id) => addUsage(u, record.rounds[id].usage), emptyUsage()),
    usage_complete: ids.every((id) => record.rounds[id].usage_complete),
    source: { channel: 'claude_code', session_id: last.session_id, agent_ids: sent, rounds: ids.length,
              completion_key: completionKey(record.task_id, ids) },
  };
}

// A completion the user approved even though no round finished cleanly. Everything
// measured so far is reported; usage_complete says plainly that it is not a clean
// figure. `result` stays "done" because that is what the USER decided — Desklog only
// stores usage for a completion, and the honest signal is usage_complete + rounds.
function partialPayload(record) {
  const p = usagePayload(record);
  return { ...p, result: 'done', usage_complete: false };
}

// ---- local state ------------------------------------------------------------
const activeFile = () => path.join(stateDir(), 'active-tasks.json');
const botsFile = (session) => path.join(stateDir(), `my-bots-${safe(session || 'none')}.json`);
const ledgerFile = () => path.join(baseDir(), 'completed-tasks.jsonl');

// The last completion written for this task, if any. Used when a workflow has more
// than one completion-like step (e.g. Done → QA → Completed): the working record is
// gone after the first one, but the same figures must go with the second.
function ledgerEntry(taskId) {
  const f = ledgerFile();
  if (!fs.existsSync(f)) return null;
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const e = JSON.parse(lines[i]); if (String(e.task_id) === String(taskId)) return e; } catch { /* skip */ }
  }
  return null;
}

module.exports = {
  fs, path, CONFIG, readStdin, readJson, writeJson, readJsonl, textOf,
  measureTranscript, upsertRound, sweepRounds, latestRound, latestFinishedRound, hasRunningRound,
  addPending, resolvePending, discoverRounds, catchUp, logHook,
  findField, findAllValues, classifyStatus, statusChange, responseObjects,
  emptyUsage, addUsage, loadRecord, saveRecord, usageFile, usagePayload, partialPayload,
  activeFile, botsFile, ledgerFile, ledgerEntry,
};
