#!/usr/bin/env node
// PostToolUse (get_my_bot_users):
//  - remembers which bot ids Desklog returned for THIS user in THIS session, so
//    create-guard.js can refuse any other assignee;
//  - tells Claude which tasks were started from this computer and not yet completed,
//    so it can tell whether the bot is busy even if Desklog's reply does not say.
const { CONFIG, readStdin, readJson, writeJson, responseObjects, findAllValues, activeFile, botsFile } = require('./lib');

const input = readStdin();
const lc = (x) => String(x).toLowerCase();
const idKeys = CONFIG.fields.bot_id_in_response.map(lc);
const listKeys = (CONFIG.fields.bot_list_keys || []).map(lc);
const skipParts = (CONFIG.fields.ignore_nested_keys_containing || []).map(lc);
const idOf = (o) => { for (const [k, v] of Object.entries(o)) if (idKeys.includes(lc(k)) && v !== null && typeof v !== 'object') return String(v); return null; };

// Preferred: the bot list itself (e.g. "bot_users": [...]) — one id per bot.
const objects = responseObjects(input.tool_response);
let ids = [];
for (const o of objects) for (const [k, v] of Object.entries(o)) {
  if (listKeys.includes(lc(k)) && Array.isArray(v)) v.forEach((b) => { if (b && typeof b === 'object') { const id = idOf(b); if (id) ids.push(id); } });
}
// Fallback (reply without a bot list): any id, but never inside task lists such as "open_tasks".
if (ids.length === 0) {
  (function walk(v) {
    if (typeof v === 'string') { try { walk(JSON.parse(v)); } catch { /* plain text */ } return; }
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const id = idOf(v); if (id) ids.push(id);
      for (const [k, w] of Object.entries(v)) if (!skipParts.some((p) => lc(k).includes(p))) walk(w);
    }
  })(input.tool_response);
}
ids = [...new Set(ids)];
writeJson(botsFile(input.session_id), { ids, saved_at: new Date().toISOString() });

const active = readJson(activeFile(), {});
const running = Object.entries(active).map(([id, a]) => `#${id} (started from this computer at ${a.started_here_at})`);
const context = running.length
  ? `Desklog plugin: tasks started from this computer and not yet completed: ${running.join(', ')}. ` +
    'Treat the bot as busy unless Desklog shows these tasks are finished (check with get_task_details).'
  : 'Desklog plugin: no task started from this computer is still running. Use Desklog\'s reply above to decide whether the bot is busy.';
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }));
process.exit(0);
