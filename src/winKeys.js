'use strict';

// The Windows key belongs to Z while Z is in full screen (O 27.11, layer 1: Windows, Z's own window).
//
// Chromium already knows how to catch the Windows key before Windows does: its keyboard lock (the same one Z uses in
// a browser's full screen for Ctrl+W, Ctrl+T, ...). That lock only works while the page itself is in full screen, so
// while Z's window is in full screen this module also puts Z's page in the page's full screen (the "hold"). The
// window is already full screen, so nothing moves on screen. Z's page then locks the Windows key (desktopHostKeys)
// and decides what it does (winKeys: the launcher, Win+D, Win+E, Win+V, Win+Shift+S).
//
// Chromium installs its key catcher only while Z's window has the focus, and drops it the moment another window
// gets it (Alt+Tab is Z's own while Z has the focus; Ctrl+Alt+Del always reaches Windows). Leaving full screen ends
// the hold. Nothing here sees or keeps any key: the keys go to Z's page as they always did.
//
// Also here: Ctrl+Alt+Esc leaves full screen (the one way back to Windows, O 27.11), and when Windows locks
// (Win+L, which no app can catch) Z is told, so Z locks too.

// A world of its own, so the page's scripts never see these two calls.
const HOLD_WORLD = 1009;
const ENTER = 'document.fullscreenElement ? true : document.documentElement.requestFullscreen().then(() => true, () => false)';
// Letting go of the hold (Z left full screen, or the person switched it off) ends the page's full screen all the way:
// a video that was in full screen over the hold goes with it, or the page would fall back into the hold in a window
// (Closure-old M2). A video in full screen in a windowed Z is never touched: only a hold this module made is let go.
const LEAVE =
  '(async () => { for (let i = 0; i < 5 && document.fullscreenElement; i++) { try { await document.exitFullscreen(); } catch { break; } } return !document.fullscreenElement; })()';

// A held Esc (2 s) or an app leaving its own full screen can end the hold: it comes back, but never in a loop.
const RETRY_MS = 400;
const MAX_TRIES = 5;
const TRIES_WINDOW_MS = 10000;

function isLeaveFullscreen(input) {
  return (
    !!input &&
    input.type === 'keyDown' &&
    input.key === 'Escape' &&
    input.control === true &&
    input.alt === true &&
    !input.meta &&
    !input.shift
  );
}

/**
 * deps:
 *   platform           process.platform (layer 1: Windows only)
 *   enabled()          the person's choice (on unless switched off)
 *   wanted()           Z's own window is in full screen, not span mode, and shows Z's page (not the offline page)
 *   contents()         Z's own window's webContents, or null
 *   now()              Date.now
 *   setTimeout/clearTimeout
 */
function createWinKeys(deps) {
  const supported = deps.platform === 'win32';
  const now = deps.now || Date.now;
  const later = deps.setTimeout || setTimeout;
  const cancel = deps.clearTimeout || clearTimeout;
  let held = false; // Chromium says the page is in its full screen
  let entering = false; // this module asked for it and Chromium has not answered yet
  let ours = false; // the page's full screen is this module's hold (with anything an app put over it)
  let timer = null;
  let tries = [];

  const wc = () => {
    const c = deps.contents();
    return c && !c.isDestroyed() ? c : null;
  };
  const want = () => supported && deps.enabled() && deps.wanted();

  function run(code) {
    const c = wc();
    if (!c) return Promise.resolve(false);
    // true: a user gesture, which the page's full screen needs
    return Promise.resolve(c.executeJavaScriptInIsolatedWorld(HOLD_WORLD, [{ code }], true)).then(
      (r) => r === true,
      () => false,
    );
  }

  function sync() {
    cancel(timer);
    timer = null;
    if (!supported) return;
    if (want() && !held) {
      const t = now();
      tries = tries.filter((x) => t - x < TRIES_WINDOW_MS);
      if (tries.length >= MAX_TRIES) return; // something keeps ending it: wait for the next real change
      tries.push(t);
      entering = true;
      run(ENTER).then(() => {
        entering = false;
      });
    } else if (!want() && ours) {
      run(LEAVE);
    }
  }

  function soon() {
    cancel(timer);
    timer = later(sync, RETRY_MS);
  }

  // Wire one webContents (Z's own window). Electron tells when the page's full screen starts and ends.
  function attach(c) {
    c.on('enter-html-full-screen', () => {
      held = true;
      // only a full screen this module asked for is its hold; a video's own full screen in a windowed Z is not
      if (entering) ours = true;
    });
    c.on('leave-html-full-screen', () => {
      held = false;
      ours = false;
      soon();
    });
    // A new page of Z (reload, sign-out) starts without the hold.
    c.on('did-start-navigation', (details) => {
      if (details && details.isMainFrame && !details.isSameDocument) {
        held = false;
        ours = false;
      }
    });
    c.on('did-finish-load', () => {
      tries = [];
      soon();
    });
  }

  // A real change (full screen, the person's choice, focus back): start counting again.
  function changed() {
    tries = [];
    sync();
  }

  return { supported, attach, changed, sync, isHeld: () => held, isOurs: () => ours };
}

module.exports = { createWinKeys, isLeaveFullscreen, HOLD_WORLD };
