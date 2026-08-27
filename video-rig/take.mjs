// One continuous take, recorded off a virtual display with nobody at the keyboard.
// Left pane: a real terminal running narrative.sh against the live project.
// Right pane: title cards -> the watched page -> the architecture -> the filed ticket.
// The two halves stay in sync through marks.txt, not through timers, because the
// crawler's cold start varies between 42 and 76 seconds.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';

const RIG = '/home/thatmike1/git/pixel-patrol/video-rig';
const DISPLAY = process.env.RIG_DISPLAY ?? ':99';
const W = 2560, H = 1440, TERM_W = 1240;
const MARKS = `${RIG}/marks.txt`;
const env = { ...process.env, DISPLAY, WAYLAND_DISPLAY: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => { try { execFileSync('xdotool', a, { env }); } catch (e) { console.error('xdotool', a.join(' '), e.message); } };
const winId = sel => execFileSync('xdotool', ['search', ...sel], { env }).toString().trim().split('\n').pop();
const hasMark = n => existsSync(MARKS) && readFileSync(MARKS, 'utf8').split('\n').some(l => l.trim() === n);

async function waitMark(name, timeoutMs = 300000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (hasMark(name)) return true; await sleep(400); }
  console.error('TIMEOUT waiting for', name);
  return false;
}

const script = process.argv[2] === 'rehearsal' ? 'narrative-rehearsal.sh' : 'narrative.sh';
const site = process.argv[2] === 'rehearsal' ? 'atelier' : 'boutique';
rmSync(MARKS, { force: true });
rmSync(`${RIG}/issue-url.txt`, { force: true });

// Stage both windows BEFORE recording, so the take opens on a composed frame.
const ctx = await launchBrowser({ profileDir: `${RIG}/profile`, x: TERM_W, y: 0, width: W - TERM_W, height: H });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`file://${RIG}/cards/title.html`);

const term = spawn('xterm', ['-fa', 'DejaVu Sans Mono', '-fs', '13', '-bg', '#0d1117', '-fg', '#c9d1d9',
  '-b', '16', '-bc', '-e', `${RIG}/${script}`], { env: { ...env, LC_ALL: 'C' }, detached: true, stdio: 'ignore' });
await sleep(3000);
xdo('windowmove', winId(['--class', 'XTerm']), '0', '0');
xdo('windowsize', winId(['--class', 'XTerm']), String(TERM_W), String(H));
const cw = winId(['--class', 'chromium']);
xdo('windowmove', cw, String(TERM_W), '0'); xdo('windowsize', cw, String(W - TERM_W), String(H));
await sleep(1500);

// Everything past this line is one unbroken recording.
const out = `${RIG}/take-${process.argv[2] ?? 'main'}.mp4`;
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '30',
  '-video_size', `${W}x${H}`, '-i', `${DISPLAY}+0,0`, '-c:v', 'libx264', '-preset', 'veryfast',
  '-crf', '20', '-pix_fmt', 'yuv420p', '-y', out], { env });
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
console.log('RECORDING ->', out);

// Cards advance in the right pane while the terminal is already working.
for (let i = 0; i < 3 && !hasMark('DRIFT_LIVE'); i++) {
  await sleep(7000);
  await page.evaluate(() => window.__next()).catch(() => {});
}
console.log(at(), 'cards done');

await waitMark('DRIFT_LIVE');
await page.goto(`https://demo-sites-b2xhora5ka-ew.a.run.app/${site}/`);
console.log(at(), 'showing the edited page');

await waitMark('SWEEP_SENT');
await sleep(8000);
await page.goto(`file://${RIG}/cards/arch.html`);
console.log(at(), 'showing the architecture');

if (await waitMark('ISSUE_READY')) {
  const url = readFileSync(`${RIG}/issue-url.txt`, 'utf8').trim();
  if (url && url.startsWith('http')) { await page.goto(url); console.log(at(), 'ticket ->', url); }
}
await sleep(14000);
console.log(at(), 'take complete');

ff.kill('SIGINT');
await sleep(3000);
try { process.kill(-term.pid); } catch {}
await ctx.close();
