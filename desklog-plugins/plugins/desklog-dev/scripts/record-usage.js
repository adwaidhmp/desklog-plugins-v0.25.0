#!/usr/bin/env node
// SubagentStop: the round ended on its own. Measure it and record how it ended.
//  completed  — the worker signed off with RESULT: DONE
//  failed     — RESULT: FAILED
//  incomplete — it stopped without saying either
// Re-measuring the same round replaces it (keyed by agent id), so nothing double-counts.
// Always exits 0: exit 2 here would stop the worker from stopping.
const { readStdin, measureTranscript, upsertRound, logHook } = require('./lib');

const WAIT_MS = Number(process.env.DESKLOG_TRANSCRIPT_WAIT_MS || 10000);
const POLL_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const input = readStdin();
  const file = input.agent_transcript_path;
  const want = (input.last_assistant_message || '').trim().slice(-200);

  // The transcript is written asynchronously; wait until it holds the final message.
  const deadline = Date.now() + WAIT_MS;
  let m = measureTranscript(file);
  while (want && !m.final_text.endsWith(want) && Date.now() < deadline) {
    await sleep(POLL_MS);
    m = measureTranscript(file);
  }
  const settled = !want || m.final_text.endsWith(want);

  logHook({ event: 'SubagentStop', agent_id: input.agent_id || null, has_transcript_path: !!file,
            task_id: m.task_id || null, settled });
  if (!m.task_id) process.exit(0); // not a Desklog round

  const finalText = input.last_assistant_message || m.final_text;
  // The hook's last message first; failing that, the RESULT line wherever the worker put
  // it — in a hand-back tool call rather than plain text, for instance.
  const result = (finalText.trim().match(/RESULT:\s*(DONE|FAILED)\s*$/i) || [, ''])[1].toLowerCase()
    || m.result || '';

  upsertRound(m.task_id, input.agent_id || `unknown-${Date.now()}`, {
    status: result === 'done' ? 'completed' : result === 'failed' ? 'failed' : 'incomplete',
    result: result || 'incomplete',
    usage: m.usage,
    seconds: m.seconds,
    usage_complete: settled,
    transcript_path: file,
    session_id: input.session_id || null,
    ended_at: new Date().toISOString(),
  });
  process.exit(0);
})();
