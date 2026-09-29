#!/usr/bin/env node
// ai-resume: run an AI CLI non-interactively; if it stops on a quota limit, sleep until the
// quota resets (+grace) and resume the same session. Works over SSH (run under tmux/nohup/systemd).
//
// usage: node ai-resume.mjs --tool claude|codex|agy --prompt "..." [--cwd dir] [--grace 180]
//          [--max-resumes 20] [--state file.json] [--webhook url] [-- extra CLI args]
//        node ai-resume.mjs status [--state file.json]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const extra = dd >= 0 ? argv.slice(dd + 1) : [];
const own = dd >= 0 ? argv.slice(0, dd) : argv;
const opt = (n, d) => { const i = own.indexOf('--' + n); return i >= 0 ? own[i + 1] : d; };
const statePath = opt('state', './ai-resume.state.json');

if (own[0] === 'status') {
  if (!existsSync(statePath)) { console.log('no state'); process.exit(0); }
  const s = JSON.parse(readFileSync(statePath, 'utf8'));
  if (s.waitingUntil) console.log(`waiting for quota reset; wake at ${new Date(s.waitingUntil).toISOString()} (in ${Math.max(0, Math.round((s.waitingUntil - Date.now()) / 1000))}s)`);
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

const tool = opt('tool', 'claude');
const prompt = opt('prompt');
const cwd = opt('cwd', process.cwd());
const graceMs = Number(opt('grace', 180)) * 1000;
const maxResumes = Number(opt('max-resumes', 20));
const webhook = opt('webhook', process.env.AI_RESUME_WEBHOOK);
const bin = opt('bin', tool === 'agy' ? 'agy' : tool);
const resumeMsg = opt('resume-prompt',
  'The usage limit has reset. Continue the previous task from where you stopped. Check PROGRESS.md / git status first if they exist.');
if (!prompt) { console.error('--prompt required'); process.exit(2); }

const state = { tool, sessionId: null, resumes: 0, waitingUntil: null, lastResetAt: null, done: false };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const log = (m) => console.error(`[ai-resume ${new Date().toISOString()}] ${m}`);
const notify = async (text) => {
  log(text);
  if (!webhook) return;
  try { await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text }) }); } catch {}
};

// ---- per-tool adapters: build args + inspect one output line ----
const LIMIT_RE = /(usage|rate|quota)[ _-]?limit|limit reached|resource_exhausted|out of (usage|credits)|hit your limit|too many requests/i;

function buildArgs(resuming) {
  if (tool === 'claude') {
    const a = ['-p', resuming ? resumeMsg : prompt, '--output-format', 'stream-json', '--verbose'];
    if (resuming && state.sessionId) a.push('--resume', state.sessionId);
    return [...a, ...extra];
  }
  if (tool === 'codex') {
    if (resuming) return ['exec', 'resume', ...(state.sessionId ? [state.sessionId] : ['--last']), '--json', '--skip-git-repo-check', ...extra, resumeMsg];
    return ['exec', '--json', '--skip-git-repo-check', ...extra, prompt];
  }
  if (tool === 'agy') {
    const a = ['-p', resuming ? resumeMsg : prompt, '--output-format', 'stream-json'];
    if (resuming && state.sessionId) a.push('--conversation', state.sessionId);
    return [...a, ...extra];
  }
  throw new Error('unknown tool ' + tool);
}

// returns {limited?:true, resetAt?:ms} pieces found in a line
function inspect(line, run) {
  let j; try { j = JSON.parse(line); } catch { if (LIMIT_RE.test(line)) run.limitText = line; return; }
  if (tool === 'claude') {
    if (j.session_id) state.sessionId = j.session_id;
    if (j.type === 'rate_limit_event') {
      const i = j.rate_limit_info || {};
      const rejected = i.status && !/^allowed/.test(i.status);
      if (rejected) { run.limited = true; run.resetAt = (i.resetsAt || 0) * 1000 || run.resetAt; }
      run.lastInfo = i;
    }
    if (j.type === 'result' && j.is_error && LIMIT_RE.test(JSON.stringify(j))) { run.limited = true; run.limitText = JSON.stringify(j).slice(0, 300); }
    if (j.type === 'result') run.gotResult = !j.is_error;
  } else if (tool === 'codex') {
    if (j.type === 'thread.started') state.sessionId = j.thread_id;
    if ((j.type === 'error' || j.type === 'turn.failed' || j.item?.type === 'error') && LIMIT_RE.test(line)) { run.limited = true; run.limitText = line.slice(0, 300); }
    if (j.type === 'turn.completed') run.gotResult = true;
  } else if (tool === 'agy') {
    const cid = j.init?.conversation_id || j.result?.conversation_id || j.step_update?.conversation_id;
    if (cid) state.sessionId = cid;
    if (LIMIT_RE.test(line)) { run.limited = true; run.limitText = line.slice(0, 300); }
    if (j.event === 'result') run.gotResult = j.result?.status === 'SUCCESS';
  }
}

// fallback: when the CLI only gave text, try to find the reset time
function guessResetAt(run) {
  if (run.resetAt) return run.resetAt;
  if (tool === 'codex') { // codex writes rate_limits into its session rollout files
    try {
      const root = join(homedir(), '.codex', 'sessions');
      const files = [];
      const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : p.endsWith('.jsonl') && files.push(p); } };
      walk(root);
      files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      for (const f of files.slice(0, 3)) {
        const m = [...readFileSync(f, 'utf8').matchAll(/"rate_limits":\{.*?"resets_at":(\d+)/g)].pop();
        if (m) return Number(m[1]) * 1000;
      }
    } catch {}
  }
  const t = run.limitText || '';
  const m = t.match(/resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) { // "resets 3pm" style: next occurrence of that clock time (local)
    let h = Number(m[1]) % 12 + (/pm/i.test(m[3] || '') ? 12 : 0); if (!m[3]) h = Number(m[1]);
    const d = new Date(); d.setHours(h, Number(m[2] || 0), 0, 0); if (d <= new Date()) d.setDate(d.getDate() + 1); return d.getTime();
  }
  return Date.now() + 5 * 3600e3; // unknown: assume one 5h window
}

function runOnce(resuming) {
  return new Promise((resolve) => {
    const run = { limited: false, resetAt: null, gotResult: false, limitText: '' };
    const p = spawn(bin, buildArgs(resuming), { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && !opt('bin') });
    let buf = '';
    const feed = (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { inspect(l, run); if (process.env.AI_RESUME_ECHO) console.log(l); } } };
    p.stdout.on('data', (d) => feed(d.toString()));
    p.stderr.on('data', (d) => { const s = d.toString(); if (LIMIT_RE.test(s)) run.limitText += s; feed(s); });
    p.on('error', (e) => { run.spawnError = e; resolve({ ...run, code: -1 }); });
    p.on('close', (code) => { if (buf.trim()) inspect(buf.trim(), run); resolve({ ...run, code }); });
  });
}

// sleeps in short chunks so a suspended machine wakes on time
const sleepUntil = async (ts) => { while (Date.now() < ts) await new Promise((r) => setTimeout(r, Math.min(30000, Math.max(250, ts - Date.now())))); };

let resuming = false;
for (;;) {
  const r = await runOnce(resuming);
  if (r.spawnError) { await notify(`cannot start ${bin}: ${r.spawnError.message}`); process.exit(3); }
  if (r.limited) {
    if (state.resumes >= maxResumes) { await notify(`hit max resumes (${maxResumes}); giving up`); process.exit(4); }
    const resetAt = guessResetAt(r);
    state.lastResetAt = resetAt; state.waitingUntil = resetAt + graceMs; save();
    await notify(`${tool} hit quota limit. Reset ${new Date(resetAt).toISOString()}; resuming at ${new Date(state.waitingUntil).toISOString()}`);
    await sleepUntil(state.waitingUntil);
    state.resumes++; state.waitingUntil = null; save();
    resuming = true; continue;
  }
  state.done = r.code === 0; save();
  await notify(`${tool} finished (exit ${r.code}, resumes=${state.resumes})`);
  process.exit(r.code || 0);
}
