#!/usr/bin/env node
// PreToolUse (change_task_status). Acts ONLY when the new status means "completed":
//  - refuses if this task has no measured work, or its latest round did not end DONE;
//  - otherwise adds the measured token usage to the call (field from desklog.config.json),
//    replacing anything the model put there, so the numbers never pass through the model.
// Any other status change (e.g. to In Progress) passes through untouched.
const { CONFIG, readStdin, statusChange, loadRecord, usagePayload, partialPayload, ledgerEntry,
        sweepRounds, latestRound, latestFinishedRound, hasRunningRound, catchUp, logHook } = require('./lib');

const out = (o) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } }));
  process.exit(0);
};
const deny = (reason) => out({ permissionDecision: 'deny', permissionDecisionReason: reason });

const input = readStdin();
const toolInput = input.tool_input || {};
const { kind, taskId } = statusChange(toolInput);
if (kind !== 'completed') process.exit(0);

if (!taskId) deny('Cannot complete: no task id in the call.');

// Find anything that was missed, then close the books on interrupted rounds, so their
// tokens count too. If the user has chosen to close the task as it stands, a round they
// stopped moments ago is stopped — not "still running" because its file is recent.
const ackFieldEarly = CONFIG.usage.partial_ack_field || 'ai_partial_confirmed';
const approvedEarly = toolInput[ackFieldEarly] === true || toolInput[ackFieldEarly] === 'true';
catchUp(input);
sweepRounds(approvedEarly ? 'user-closed' : 'before-complete');
logHook({ event: 'PreToolUse:complete', task_id: taskId, has_transcript_path: !!input.transcript_path,
          approved_partial: approvedEarly });

const record = loadRecord(taskId);
if (!record || !record.rounds || Object.keys(record.rounds).length === 0) {
  // Already reported once (e.g. this workflow goes In Progress → Done → Completed):
  // send exactly the same figures again. The completion_key is unchanged, so Desklog
  // recognises the repeat and cannot count it twice.
  const earlier = ledgerEntry(taskId);
  if (earlier) {
    const { task_id, completed_here_at, ...payload } = earlier;
    out({ permissionDecision: 'allow', updatedInput: { ...toolInput, [CONFIG.usage.field]: payload } });
  }
  deny(`Task #${taskId} has no measured work on this computer: no task-worker round ever ran for it. ` +
       'There is nothing to record, so run a round, or close the task in the Desklog web app.');
}
if (hasRunningRound(record) && !approvedEarly) {
  deny(`Task #${taskId} has a round that may still be running. ASK THE USER which they want: ` +
       'mark it Done now with the work recorded so far, or keep working and finish it first. ' +
       `If they choose Done now, call this tool again with ${ackFieldEarly}: true.`);
}

const ackField = CONFIG.usage.partial_ack_field || 'ai_partial_confirmed';
const userApprovedPartial = toolInput[ackField] === true || toolInput[ackField] === 'true';
const measured = Object.values(record.rounds).some((r) => r.usage && r.usage.total_tokens > 0);
// No round finished cleanly. That is the user's call, not ours: they may want the task
// closed as it stands. We only insist they are ASKED first — the marker below is set
// once they have answered, and the stored figures say the work was never verified.
const last = latestRound(record);
const unfinished = !last || last.result !== 'done'
  || last.status === 'interrupted' || last.status === 'cancelled';

if (unfinished && !userApprovedPartial) {
  const how = last ? (last.status === 'completed' ? `ended as "${last.result}"` : `was ${last.status}`)
                   : 'never ran';
  deny(`Task #${taskId} has no round that finished cleanly — its latest round ${how}. ` +
       (measured
         ? `ASK THE USER which they want: mark it Done now with the work recorded so far ` +
           `(tokens and seconds measured up to the interruption), or keep working and finish it first. ` +
           `If they choose Done now, call this tool again with ${ackField}: true.`
         : 'Nothing was measured for it on this computer, so there is nothing to record. ' +
           'Run a round, or close the task in the Desklog web app.'));
}
if (unfinished && userApprovedPartial && !measured) {
  deny(`Task #${taskId} has no measured work at all, so there is nothing to report. ` +
       'Run a round, or close the task in the Desklog web app.');
}
if (!CONFIG.usage.inject_into_status_call) process.exit(0);

// The marker is for this hook only — it never goes to Desklog.
const { [ackField]: _ack, ...clean } = toolInput;
out({ permissionDecision: 'allow',
      updatedInput: { ...clean, [CONFIG.usage.field]: unfinished ? partialPayload(record) : usagePayload(record) } });
