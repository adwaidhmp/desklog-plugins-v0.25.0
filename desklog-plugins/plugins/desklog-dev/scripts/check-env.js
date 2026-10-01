#!/usr/bin/env node
// Prints what the plugin needs to work. Run through run-node.sh so it uses the same
// Node the hooks use. Reads only; changes nothing, installs nothing.
const fs = require('fs'), os = require('os'), path = require('path');

const root = path.join(__dirname, '..');
const read = (p, d) => { try { return JSON.parse(fs.readFileSync(path.join(root, p), 'utf8')); } catch { return d; } };
const manifest = read('.claude-plugin/plugin.json', {});
const config = read('desklog.config.json', null);

const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const dataDir = expand(process.env.DESKLOG_PLUGIN_DATA) || expand(config && config.data_dir)
  || process.env.CLAUDE_PLUGIN_DATA || path.join(os.tmpdir(), 'desklog-plugin');

let writable = false;
try { fs.mkdirSync(dataDir, { recursive: true }); fs.accessSync(dataDir, fs.constants.W_OK); writable = true; } catch { /* no */ }

const major = Number(process.versions.node.split('.')[0]);
const ledger = path.join(dataDir, 'completed-tasks.jsonl');
let measured = 0;
try { measured = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length; } catch { /* none yet */ }

process.stdout.write(JSON.stringify({
  plugin: `${manifest.name || '?'} ${manifest.version || '?'}`,
  node: { version: process.versions.node, path: process.execPath, supported: major >= 18 },
  platform: `${os.platform()} ${os.arch()}`,
  config_readable: !!config,
  data_dir: dataDir,
  data_dir_writable: writable,
  tasks_measured_here: measured,
  ok: !!config && writable && major >= 18,
}, null, 2) + '\n');
