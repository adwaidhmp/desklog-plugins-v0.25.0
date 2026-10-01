---
name: check
description: Check that the Desklog plugin can actually measure work — Node, hooks, data folder and the Desklog connection. Use when the user invokes /desklog-dev:check, or when a completion reports that usage was not recorded.
---

Report what is working and what is not. Do not install anything, ever — if something is
missing, tell the user the command to run themselves.

1. **Node and the plugin.** Run, in one Bash call, exactly the command shape the hooks
   use, so a failure here means the hooks would fail too:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/hook.js" check-env`
   If that path does not resolve, find the newest installed copy instead:
   `find ~/.claude/plugins/cache -name hook.js | sort | tail -1`
   - It prints JSON → say the plugin version, the Node version and path, the data folder
     and how many tasks have been measured on this machine.
   - It fails with "node: not found" (or similar) → Node is not on the PATH Claude Code
     runs hooks with, so NOTHING will be measured until that is fixed. Tell the user to
     install Node (`brew install node`, `winget install OpenJS.NodeJS`, nvm, or their
     package manager) or to start Claude Code from a shell where `node` works.
     Never run an installer yourself.
   - `node.supported` is false → Node is older than 18; ask them to upgrade.

2. **Hooks.** Tell the user to open `/hooks` and confirm five entries run
   `node "<plugin>/scripts/hook.js" …` (1 SubagentStop, 2 PreToolUse, 2 PostToolUse). You cannot
   read that list yourself. If they are missing, the usual cause is that the plugin was
   installed or upgraded while this session was open: restart Claude Code.

3. **What the hooks actually saw.** Show the last 15 lines of
   `<data_dir>/state/hook-log.jsonl` (the data folder printed in step 1). Each line says
   which hook fired, whether it could see a task id and a transcript, and what it did
   (registered / parked). A worker that ran but never shows "SubagentStart" or
   "SubagentStop" means those events are not reaching the plugin.

4. **Desklog.** Call `get_my_bot_users`. Report the bot it returns, or say no bot is
   linked. If the call fails, say the connection needs signing in again via `/mcp`.

5. **Verdict.** One line: either everything needed to measure a task is in place, or the
   exact thing that is not.
