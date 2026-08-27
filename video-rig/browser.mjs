// Chromium for the recording stage: no banners, no horizontal tab strip, no selected
// omnibox text over the .run.app URL a judge has to read.
import { chromium } from '/home/thatmike1/git/pixel-patrol/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';

// Playwright 1.48 bundles Chromium 130, which has no vertical tabs at all. The system
// Chrome is new enough; Chrome for Testing works too but adds its own infobar.
const SYSTEM_CHROME = '/usr/bin/google-chrome';
const CFT = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

export async function launchBrowser({ profileDir, x = 0, y = 0, width = 1320, height = 1440, sidebarWidth = 200 }) {
  rmSync(profileDir, { recursive: true, force: true });      // a stale profile restores old tabs
  mkdirSync(`${profileDir}/Default`, { recursive: true });

  // Vertical tabs is a chrome://flags entry, not a --enable-features switch; seeding the
  // labs experiment plus the pref is the only route that takes effect.
  writeFileSync(`${profileDir}/Local State`,
    JSON.stringify({ browser: { enabled_labs_experiments: ['vertical-tabs@1'] } }));
  writeFileSync(`${profileDir}/Default/Preferences`, JSON.stringify({
    vertical_tabs: { enabled: true, enabled_first_time: true, collapsed_state: true, uncollapsed_width: sidebarWidth },
    translate: { enabled: false },   // the bubble survives --disable-features=Translate
  }));

  const usingCfT = !existsSync(SYSTEM_CHROME);
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: usingCfT ? CFT : SYSTEM_CHROME,
    chromiumSandbox: true,                       // else Playwright injects --no-sandbox and Chrome warns about it
    ignoreDefaultArgs: ['--enable-automation'],  // exact-string match, so it cannot filter --disable-features=...
    args: [
      '--ozone-platform=x11',                    // without this Chromium follows WAYLAND_DISPLAY to the real desktop
      `--window-position=${x},${y}`, `--window-size=${width},${height}`,
      // one merged value: Chrome keeps only the last --disable-features it is given
      '--disable-features=Translate,TranslateUI,GCM,MediaRouter,AutomationControlled',
      '--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble',
      ...(usingCfT ? ['--disable-infobars'] : []),
    ],
    viewport: null,
  });

  // Chrome starts with the omnibox focused and its text selected, which records as an
  // orange block over the URL. A CDP click cannot move browser-widget focus; a real
  // pointer click can. Do it while the tab is still blank so nothing is clickable.
  const env = { ...process.env, WAYLAND_DISPLAY: '' };
  try {
    execFileSync('xdotool', ['mousemove', String(x + Math.floor(width / 2)), String(y + Math.floor(height / 2)),
      'click', '1'], { env });
    execFileSync('xdotool', ['mousemove', '0', String(height - 1)], { env });   // park the pointer out of frame
  } catch (e) { console.error('focus-blur click failed:', e.message); }

  return ctx;
}
