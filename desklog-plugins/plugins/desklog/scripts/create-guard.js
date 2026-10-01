#!/usr/bin/env node
// PreToolUse (create_task): a task may only be assigned to a bot id that
// get_my_bot_users returned for this user in this session. Desklog must enforce the
// same rule on the server — this is an early, local refusal, not the real guarantee.
const { CONFIG, readStdin, readJson, findAllValues, botsFile } = require('./lib');

const input = readStdin();
// Proof of life: if you never see this line when a task is created, the hooks are not
// running, and nothing will be measured or gated later in the run.
const alive = (extra) => { process.stdout.write(JSON.stringify({ systemMessage: `Desklog plugin: hooks active${extra || ''}` })); process.exit(0); };

const assignees = findAllValues(input.tool_input || {}, CONFIG.fields.assignee);
if (assignees.length === 0) alive(' (Desklog will assign the task)');

const deny = (reason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
};

const mine = readJson(botsFile(input.session_id), null);
if (!mine) deny('Call get_my_bot_users first, then assign the task only to the bot it returns.');
const foreign = assignees.filter((a) => !mine.ids.includes(a));
if (foreign.length) {
  deny(`Tasks can only be assigned to your own bot. ${foreign.join(', ')} is not a bot returned by get_my_bot_users` +
       (mine.ids.length ? ` (your bot ids: ${mine.ids.join(', ')}).` : '.'));
}
alive(' — this task will be measured');
