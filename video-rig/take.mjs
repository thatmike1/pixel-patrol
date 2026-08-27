// One continuous take: title cards -> tiled terminal+browser -> live sweep -> ticket.
// Everything runs on Xvfb :99 and is captured by one ffmpeg x11grab process.
import { chromium } from '/home/thatmike1/git/pixel-patrol/node_modules/playwright/index.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';

const RIG = '/home/thatmike1/git/pixel-patrol/video-rig';
const DISPLAY = ':99';
const MARKS = `${RIG}/marks.txt`;
const env = { ...process.env, DISPLAY, WAYLAND_DISPLAY: '' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => { try { execFileSync('xdotool', a, { env }); } catch (e) { console.error('xdotool', a.join(' '), e.message); } };
const winId = sel => execFileSync('xdotool', ['search', ...sel], { env }).toString().trim().split('\n').pop();

const marksSeen = new Set();
async function waitMark(name, timeoutMs = 240000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(MARKS) && readFileSync(MARKS, 'utf8').split('\n').some(l => l.trim() === name)) return true;
    await sleep(400);
  }
  console.error('TIMEOUT waiting for mark', name);
  return false;
}

rmSync(MARKS, { force: true });

// 1. browser, fullscreen, on the title card
const ctx = await chromium.launchPersistentContext(`${RIG}/profile`, {
  headless: false,
  ignoreDefaultArgs: ['--enable-automation'],   // kills the "controlled by automated test software" banner
  args: ['--no-sandbox', '--ozone-platform=x11', '--window-position=0,0', '--window-size=1920,1080',
         '--disable-features=Translate,TranslateUI,GCM,MediaRouter', '--no-first-run',
         '--no-default-browser-check', '--hide-crash-restore-bubble'],
  viewport: null,
});
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto(`file://${RIG}/cards/title.html`);
await sleep(1500);

// 2. ffmpeg starts here. Everything after this point is one unbroken recording.
const out = `${RIG}/take-${process.argv[2] ?? 'x'}.mp4`;
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'x11grab', '-framerate', '30',
  '-video_size', '1920x1080', '-i', `${DISPLAY}+0,0`, '-c:v', 'libx264', '-preset', 'veryfast',
  '-crf', '20', '-pix_fmt', 'yuv420p', '-y', out], { env });
console.log('RECORDING ->', out);
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

// 3. title cards
for (let i = 0; i < 3; i++) { await sleep(8000); await page.evaluate(() => window.__next()); }
await sleep(7000);
console.log(at(), 'cards done');

// 4. terminal enters, browser shrinks to the right pane
const term = spawn('xterm', ['-fa', 'DejaVu Sans Mono', '-fs', '11', '-bg', '#0d1117', '-fg', '#c9d1d9',
  '-b', '14', '-bc', '-e', `${RIG}/narrative-rehearsal.sh`], { env: { ...env, LC_ALL: 'C' }, detached: true, stdio: 'ignore' });
await sleep(2500);
const xw = winId(['--class', 'XTerm']);
const cw = winId(['--class', 'chromium']);
xdo('windowmove', xw, '0', '0'); xdo('windowsize', xw, '950', '1080');
xdo('windowmove', cw, '950', '0'); xdo('windowsize', cw, '970', '1080');
await page.goto('https://demo-sites-b2xhora5ka-ew.a.run.app/boutique/');
console.log(at(), 'tiled');

// 5. follow the narrative script's markers
await waitMark('DRIFT_LIVE');
await page.reload();                                  // the edited page, live
console.log(at(), 'page reloaded after edit');

await waitMark('SWEEP_SENT');
await sleep(4000);
await page.goto(`file://${RIG}/cards/arch.html`);     // fill the wait with the architecture
console.log(at(), 'showing architecture');

const gotIssue = await waitMark('ISSUE_READY', 300000);
if (gotIssue) {
  const url = readFileSync(`${RIG}/issue-url.txt`, 'utf8').trim();
  await page.goto(url);
  console.log(at(), 'issue ->', url);
}
await sleep(12000);
console.log(at(), 'take complete');

ff.kill('SIGINT');
await sleep(3000);
try { process.kill(-term.pid); } catch {}
await ctx.close();
