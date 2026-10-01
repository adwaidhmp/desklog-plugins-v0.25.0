#!/usr/bin/env node
// SubagentStart: register the round the moment it begins. If its task id cannot be
// read yet — the start event may not carry the prompt, and the transcript may still be
// empty — park it; it is resolved as soon as its transcript names the task.
const { readStdin, measureTranscript, upsertRound, addPending, logHook, textOf } = require('./lib');

const input = readStdin();
const file = input.agent_transcript_path || null;
const agentId = input.agent_id || `unknown-${Date.now()}`;

const promptText = typeof input.prompt === 'string' ? input.prompt : textOf(input.prompt);
const fromPrompt = (promptText || '').match(/^\s*DESKLOG_TASK_ID:\s*(\S+)/m);
const taskId = (fromPrompt && fromPrompt[1]) || measureTranscript(file).task_id;

logHook({ event: 'SubagentStart', agent_id: agentId, agent_type: input.agent_type || null,
          has_prompt: !!promptText, has_transcript_path: !!file, task_id: taskId || null,
          action: taskId ? 'registered' : 'parked' });

const info = { transcript_path: file, session_id: input.session_id || null, started_at: new Date().toISOString() };
if (taskId) upsertRound(taskId, agentId, { status: 'running', ...info });
else addPending(agentId, info);
process.exit(0);
