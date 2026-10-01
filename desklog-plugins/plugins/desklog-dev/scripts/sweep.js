#!/usr/bin/env node
// SessionStart / SessionEnd / Stop: find any round that was missed, then close the books
// on rounds that never ended normally, KEEPING whatever they spent:
//   cancelled   — the session ended while it was running
//   interrupted — it stopped being written and never reported back
const { readStdin, sweepRounds, catchUp, logHook } = require('./lib');

const input = readStdin();
const event = input.hook_event_name || '';
const reason = event === 'SessionEnd' ? 'session-end' : event === 'SessionStart' ? 'session-start' : 'turn-end';
catchUp(input);
const touched = sweepRounds(reason);
logHook({ event: event || 'sweep', has_transcript_path: !!input.transcript_path, touched });

if (touched.length && reason !== 'turn-end') {
  process.stdout.write(JSON.stringify({
    systemMessage: `Desklog plugin: kept the measured work of unfinished round(s) on task(s) ${[...new Set(touched)].join(', ')}.`,
  }));
}
process.exit(0);
