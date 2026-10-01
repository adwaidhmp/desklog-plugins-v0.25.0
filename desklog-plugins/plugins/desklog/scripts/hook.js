#!/usr/bin/env node
// Single entry point for every Desklog hook, so hooks.json can name one command that
// works on Linux, macOS and Windows: node "<plugin>/scripts/hook.js" <name>
// Claude Code runs shell-form hooks through sh on Linux/macOS and Git Bash or
// PowerShell on Windows; that command line is valid in all of them. A bare .sh path
// is NOT — on Windows it is opened by file association instead of being run.
const HOOKS = {
  'record-usage': './record-usage.js',
  'round-start': './round-start.js',
  'sweep': './sweep.js',
  'status-pre': './status-pre.js',
  'status-post': './status-post.js',
  'bots-post': './bots-post.js',
  'create-guard': './create-guard.js',
  'check-env': './check-env.js',
};

const name = process.argv[2];
if (!HOOKS[name]) {
  process.stderr.write(`desklog hook: unknown hook "${name}". Known: ${Object.keys(HOOKS).join(', ')}\n`);
  process.exit(0); // never fail the tool call over plugin wiring
}
require(HOOKS[name]);
