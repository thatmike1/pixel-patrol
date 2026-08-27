// banner-free chromium launcher for the video rig.
// three banners have to stay dead for a clean recording:
//   1. "Chrome is being controlled by automated test software"  -> ignoreDefaultArgs: ['--enable-automation']
//   2. "You are using an unsupported command-line flag: --no-sandbox" -> chromiumSandbox: true (playwright
//      injects --no-sandbox unless you ask for the sandbox explicitly). needs
//      kernel.apparmor_restrict_unprivileged_userns=0, otherwise chrome refuses to start.
//   3. "Chrome for Testing ... is only for automated testing" -> use the installed google-chrome stable
//      build instead of playwright's bundled chrome-for-testing.
// vertical tabs come from the chrome://flags entry `vertical-tabs`, seeded into the profile's
// `Local State` before launch, plus the `vertical_tabs` prefs in `Default/Preferences`.
import { chromium } from '/home/thatmike1/git/pixel-patrol/node_modules/playwright/index.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// playwright 1.48 bundles chromium 130, which predates vertical tabs. stable chrome first,
// then the newest chrome-for-testing build (which needs --disable-infobars for its own banner).
const CHROME_CANDIDATES = [
  { path: '/usr/bin/google-chrome', infobars: false },
  { path: '/usr/bin/google-chrome-stable', infobars: false },
  { path: `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`, infobars: true },
];

// playwright's own --disable-features list, plus the rig's additions. passed as one switch:
// chrome keeps only one value per switch name, so a second --disable-features would fight it.
const DISABLED_FEATURES = [
  'ImprovedCookieControls', 'LazyFrameLoading', 'GlobalMediaControls', 'DestroyProfileOnBrowserClose',
  'MediaRouter', 'DialMediaRouteProvider', 'AcceptCHFrame', 'AutoExpandDetailsElement',
  'CertificateTransparencyComponentUpdater', 'AvoidUnnecessaryBeforeUnloadCheckSync', 'Translate',
  'TranslateUI', 'HttpsUpgrades', 'PaintHolding', 'ThirdPartyStoragePartitioning', 'LensOverlay', 'GCM',
];

/**
 * seed a fresh profile so the first paint is already in its final state — no flag toggling,
 * no restart, no translate bubble over the page.
 * @param {string} profileDir
 * @param {number} sidebarWidth
 */
function seedProfile(profileDir, sidebarWidth) {
  mkdirSync(`${profileDir}/Default`, { recursive: true });
  writeFileSync(`${profileDir}/Local State`, JSON.stringify({
    browser: { enabled_labs_experiments: ['vertical-tabs@1'] }, // @1 == "Enabled" in chrome://flags
  }));
  writeFileSync(`${profileDir}/Default/Preferences`, JSON.stringify({
    vertical_tabs: { enabled: true, enabled_first_time: true, collapsed_state: false, uncollapsed_width: sidebarWidth },
    translate: { enabled: false },                     // the --disable-features route does not stop the bubble
    credentials_enable_service: false,
    profile: { password_manager_leak_detection: false },
    signin: { allowed: false },
  }));
}

/**
 * chrome opens with the omnibox focused and its URL text selected, which records as an orange
 * highlight over the one thing the judges have to read. CDP clicks do not move browser-widget
 * focus and there is no window manager to accept keystrokes, so this has to be a real X click
 * inside the web contents - done while the tab is still about:blank, so nothing can be hit.
 * @param {number} x window origin
 * @param {number} y
 * @param {number} width window size
 * @param {number} height
 * @param {number} sidebarWidth vertical tab strip width, excluded from the click target
 */
function blurOmnibox(x, y, width, height, sidebarWidth) {
  try {
    const [screenW, screenH] = execFileSync('xdotool', ['getdisplaygeometry']).toString().trim().split(' ').map(Number);
    const cx = x + sidebarWidth + Math.round((width - sidebarWidth) / 2);
    const cy = y + Math.round(height / 2);
    execFileSync('xdotool', ['mousemove', String(cx), String(cy), 'click', '1']);
    execFileSync('xdotool', ['mousemove', String(screenW - 1), String(screenH - 1)]);
  } catch (e) {
    console.error('browser.mjs: could not blur the omnibox -', e.message);
  }
}

/**
 * launch a persistent chromium for recording: no banners, vertical tab strip, URL bar visible.
 * @param {object} opts
 * @param {string} opts.profileDir  user-data-dir; wiped-and-reseeded on every launch
 * @param {number} [opts.x]         window position
 * @param {number} [opts.y]
 * @param {number} [opts.width]     window size
 * @param {number} [opts.height]
 * @param {number} [opts.sidebarWidth] uncollapsed vertical tab strip width, px
 * @param {string} [opts.executablePath] override the browser binary
 * @returns {Promise<import('playwright').BrowserContext>} persistent context, viewport = real window
 */
export async function launchBrowser({
  profileDir, x = 0, y = 0, width = 1600, height = 1400, sidebarWidth = 240, executablePath,
} = {}) {
  if (!profileDir) throw new Error('launchBrowser: profileDir is required');

  const chrome = executablePath
    ? { path: executablePath, infobars: !executablePath.startsWith('/usr/bin/') }
    : CHROME_CANDIDATES.find(c => existsSync(c.path));
  if (!chrome) throw new Error('launchBrowser: no chrome binary found');

  seedProfile(profileDir, sidebarWidth);

  const args = [
    '--ozone-platform=x11',
    `--window-position=${x},${y}`,
    `--window-size=${width},${height}`,
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-crash-restore-bubble',
  ];
  // only chrome-for-testing builds carry the "only for automated testing" strip.
  if (chrome.infobars) args.push('--disable-infobars');

  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    executablePath: chrome.path,
    chromiumSandbox: true,                          // kills the --no-sandbox flag and its banner
    ignoreDefaultArgs: ['--enable-automation'],     // kills the automation banner
    args,
    viewport: null,
  });

  blurOmnibox(x, y, width, height, sidebarWidth);
  return ctx;
}

export default launchBrowser;
