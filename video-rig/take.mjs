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
process.env.DISPLAY = DISPLAY;
process.env.WAYLAND_DISPLAY = '';
// browser on the left and wider: the architecture diagram is landscape, so pane width
// is what limits how big it can render.
const W = 2560, H = 1440, BROWSER_W = 1500;
const MARKS = `${RIG}/marks.txt`;
// Cards used to load straight off disk, which put a local home path in the address bar for
// most of the take. A throwaway static server keeps the bar clean.
const CARD_PORT = 8123;
const CARDS = `http://localhost:${CARD_PORT}/cards`;
const env = { ...process.env, DISPLAY, WAYLAND_DISPLAY: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => { try { execFileSync('xdotool', a, { env }); } catch (e) { console.error('xdotool', a.join(' '), e.message); } };
// matches Chromium-browser and Google-chrome alike; retries because the window is mapped
// asynchronously after launch and there is no window manager to wait on.
function winId(sel, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      const id = execFileSync('xdotool', ['search', ...sel], { env }).toString().trim().split('\n').pop();
      if (id) return id;
    } catch { /* not mapped yet */ }
    execFileSync('sleep', ['0.5']);
  }
  throw new Error(`no window for ${sel.join(' ')}`);
}
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

// Ensure Xvfb is running on DISPLAY before staging windows
try {
  execFileSync('xdpyinfo', [], { env });
} catch {
  console.log(`starting Xvfb on ${DISPLAY}...`);
  spawn('Xvfb', [DISPLAY, '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 40; i++) {
    try {
      execFileSync('xdpyinfo', [], { env });
      break;
    } catch {
      await sleep(250);
    }
  }
}

const cardServer = spawn('python3', ['-m', 'http.server', String(CARD_PORT), '--bind', '127.0.0.1',
  '--directory', RIG], { stdio: 'ignore', detached: true });
await sleep(800);

// Stage both windows BEFORE recording, so the take opens on a composed frame.
const ctx = await launchBrowser({ profileDir: `${RIG}/profile`, x: 0, y: 0, width: BROWSER_W, height: H });
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`${CARDS}/title.html`);

const term = spawn('xterm', ['-fa', 'DejaVu Sans Mono', '-fs', '15', '-bg', '#0d1117', '-fg', '#c9d1d9',
  '-b', '16', '-bc', '-e', `${RIG}/${script}`], { env: { ...env, LC_ALL: 'C.UTF-8' }, detached: true, stdio: 'ignore' });
await sleep(3000);
const xw = winId(['--class', 'XTerm']);
xdo('windowmove', xw, String(BROWSER_W), '0'); xdo('windowsize', xw, String(W - BROWSER_W), String(H));
const cw = winId(['--class', 'chrom']);
xdo('windowmove', cw, '0', '0'); xdo('windowsize', cw, String(BROWSER_W), String(H));
await sleep(1500);

// Everything past this line is one unbroken recording.
const out = `${RIG}/take-${process.argv[2] ?? 'main'}.mp4`;
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '30',
  '-video_size', `${W}x${H}`, '-i', `${DISPLAY}+0,0`, '-c:v', 'libx264', '-preset', 'veryfast',
  '-crf', '20', '-pix_fmt', 'yuv420p', '-y', out], { env });
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
console.log('RECORDING ->', out);

// Cards advance while the terminal is already working. 10s a card: a cold viewer reads a
// paragraph card in about that, and anything under 8s reads as rushed. The last card then
// holds itself (rotating copy, pointer at the terminal) until DRIFT_LIVE, however long that is.
for (let i = 0; i < 3 && !hasMark('DRIFT_LIVE'); i++) {
  await sleep(10000);
  await page.evaluate(() => window.__next()).catch(() => {});
}
console.log(at(), 'cards done');

await waitMark('DRIFT_LIVE');
await page.goto(`https://demo-sites-b2xhora5ka-ew.a.run.app/${site}/`);
console.log(at(), 'showing the edited page');

await waitMark('SWEEP_SENT');
await sleep(8000);
await page.goto(`${CARDS}/arch.html`);
console.log(at(), 'showing the architecture');

// Stage strip. Every tick is a mark written when the pipeline logged the matching line, so
// the strip cannot run ahead of the run. Bar durations are the last measured ones (take11:
// 70.6s cold start, 11.8s crawl, 48.2s agent) and are labelled as typical, not promised.
const drive = (fn, ...a) => page.evaluate(([f, args]) => window[f]?.(...args), [fn, a]).catch(() => {});
await drive('__stage', 'crawl', 'run');
await drive('__bar', 'crawler container cold start \u00b7 typically ~70s', 70);
(async () => {
  if (await waitMark('CRAWL_BOOTED', 240000)) {
    await drive('__stage', 'crawl', 'done');
    await drive('__stage', 'fingerprint', 'run');
    await drive('__bar', 'crawl, fingerprint, diff \u00b7 typically ~12s', 12);
  }
  if (await waitMark('CRAWL_DONE', 240000)) {
    await drive('__stage', 'fingerprint', 'done');
    await drive('__stage', 'agent', 'run');
    await drive('__bar', 'two Gemini agents on Vertex \u00b7 typically ~48s', 48);
  }
  if (await waitMark('TICKET_FILED', 240000)) {
    await drive('__stage', 'agent', 'done');
    await drive('__stage', 'ticket', 'done');
    await drive('__barDone');
    await drive('__bar', 'ticket filed', 1);
  }
})();

if (await waitMark('ISSUE_READY')) {
  const url = readFileSync(`${RIG}/issue-url.txt`, 'utf8').trim();
  if (url && url.startsWith('http')) {
    await page.goto(url);
    console.log(at(), 'ticket ->', url);
    const elapsed = Date.now() - t0;
    // No floor: the 4:00 cap is the one binary rule, so a slow pipeline eats the payoff
    // rather than the other way round.
    const dwell = Math.max(0, Math.min(40000, 236000 - elapsed));
    console.log(at(), `payoff dwell ${(dwell / 1000).toFixed(1)}s (elapsed ${(elapsed / 1000).toFixed(1)}s)`);

    // smooth step scroll so redline and RoPA row each get readable screen time
    const tEnd = Date.now() + dwell;
    await sleep(Math.min(4000, dwell * 0.2));
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' })).catch(() => {});
    await sleep(Math.min(10000, dwell * 0.35));
    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' })).catch(() => {});
    const remaining = Math.max(0, tEnd - Date.now());
    if (remaining > 0) await sleep(remaining);
  }
} else {
  await sleep(11000);
}
console.log(at(), 'take complete');

ff.kill('SIGINT');
await sleep(3000);
try { process.kill(-term.pid); } catch {}
try { process.kill(-cardServer.pid); } catch {}
await ctx.close();
process.exit(0);
