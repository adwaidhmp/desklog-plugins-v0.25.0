#!/usr/bin/env node
// PostToolUse (change_task_status) — runs only when Desklog ACCEPTED the change.
//  - In Progress → remember the task as running on this computer.
//  - Completed   → forget it, write the final usage to completed-tasks.jsonl (a local
//                  copy that survives even if Desklog does not store usage yet), and
//                  delete the working record.
// If Desklog refused or was unreachable, this never runs and the record stays for a retry.
const { fs, readStdin, readJson, writeJson, statusChange, loadRecord, usagePayload,
        usageFile, activeFile, ledgerFile } = require('./lib');
const path = require('path');

const input = readStdin();
const { kind, taskId } = statusChange(input.tool_input || {});
if (!taskId || kind === 'other') process.exit(0);

const active = readJson(activeFile(), {});
if (kind === 'in_progress') {
  active[taskId] = { started_here_at: new Date().toISOString(), session_id: input.session_id || null };
  writeJson(activeFile(), active);
  process.exit(0);
}

if (kind === 'paused') {
  // The bot is free again, but the task is not finished: keep its measured rounds so a
  // later resume-and-complete still reports every round.
  delete active[taskId];
  writeJson(activeFile(), active);
  process.exit(0);
}

// completed
delete active[taskId];
writeJson(activeFile(), active);
const record = loadRecord(taskId);
if (record && record.rounds && Object.keys(record.rounds).length) {
  const line = { task_id: taskId, completed_here_at: new Date().toISOString(), ...usagePayload(record) };
  fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
  fs.appendFileSync(ledgerFile(), JSON.stringify(line) + '\n');
  try { fs.unlinkSync(usageFile(taskId)); } catch { /* already gone */ }
}
process.exit(0);
