'use strict';

// Where a page inside the Z window may go.
// The top of the window (Z itself) stays on Z: anything else is stopped and opens in the person's browser,
// and Google sign-in gets a short explanation instead.
// A frame inside Z (a site shown in ZeuS, an app) navigates and follows server redirects like in any browser:
// it cannot move the window (ZeuS frames have no allow-top-navigation, and a top navigation is a main-frame
// navigation, which this guard still stops), and its own headers decide whether it may show inside Z.
// Before this, a site that redirected inside a ZeuS frame (example.com -> www.example.com) was cut off and
// opened in the browser instead (Electron's will-redirect fires for frames too, will-navigate only for the top).

// The update screen at start (update.html) asks for its two buttons by trying to open itself with ?do=update or
// ?do=later: that navigation is always stopped, and only that exact page and those two words reach onUpdateAction.

function updateAction(url, updateUrl) {
  const [base, query = ''] = String(url).split('?');
  if (!updateUrl || base !== updateUrl) return null;
  const what = new URLSearchParams(query).get('do');
  return what === 'update' || what === 'later' ? what : '';
}

function createNavigationGuard({ cfg, offlineUrl, openOutside, explainGoogle, updateUrl, onUpdateAction }) {
  return function onNavigate(event, url) {
    if (event && event.isMainFrame === false) return;
    const what = updateAction(url, updateUrl);
    if (what !== null) {
      event.preventDefault();
      if (what && onUpdateAction) onUpdateAction(what);
      return;
    }
    if (String(url).split('?')[0] === offlineUrl) return;
    if (cfg.isInWindowUrl(url)) return;
    event.preventDefault();
    if (cfg.isGoogleSignIn(url)) explainGoogle();
    else openOutside(url);
  };
}

module.exports = { createNavigationGuard, updateAction };
