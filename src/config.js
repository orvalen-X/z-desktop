'use strict';

// Where Z lives. Only Z loads inside the Z window.
// Everything else opens in the person's normal browser.

const START_URL = 'https://orvalen.me/';

// Z itself, exact hosts only (no subdomains). The marketing site is not here on purpose: the window shows Z.
const APP_HOSTS = ['orvalen.me'];

// Google blocks sign-in inside embedded browsers such as this one.
// Until the browser sign-in layer lands, these get a short explanation instead.
const GOOGLE_SIGNIN_HOSTS = ['accounts.google.com'];

function hostMatches(host, list) {
  const h = String(host || '').toLowerCase();
  return list.some((d) => h === d || h.endsWith('.' + d));
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isAppUrl(url) {
  const u = parse(url);
  return !!u && u.protocol === 'https:' && u.port === '' && APP_HOSTS.includes(u.hostname.toLowerCase());
}

// Today the window shows exactly the Z hosts. Kept separate so later layers can widen one without the other.
function isInWindowUrl(url) {
  return isAppUrl(url);
}

function isGoogleSignIn(url) {
  const u = parse(url);
  return !!u && hostMatches(u.hostname, GOOGLE_SIGNIN_HOSTS);
}

function isExternalSafe(url) {
  const u = parse(url);
  return !!u && (u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:');
}

module.exports = {
  START_URL,
  isAppUrl,
  isInWindowUrl,
  isGoogleSignIn,
  isExternalSafe,
  hostMatches,
};
