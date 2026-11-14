'use strict';

// Where Z lives. Only Z loads inside the Z window.
// Everything else opens in the person's normal browser.

const START_URL = 'https://orvalen.me/';

// Z itself, subdomains included. The marketing site is not here on purpose: the window shows Z.
const APP_HOSTS = ['orvalen.me'];

// Google blocks sign-in inside embedded browsers such as this one.
// Until the browser sign-in layer lands, these get a short explanation instead.
const GOOGLE_SIGNIN_HOSTS = ['accounts.google.com'];

// What Z may ask for, and only from APP_HOSTS. Anything else is refused.
const ALLOWED_PERMISSIONS = new Set([
  'media', // camera and microphone for calls
  'notifications',
  'fullscreen',
  'geolocation',
  'clipboard-sanitized-write',
  'pointerLock',
]);

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
  return !!u && u.protocol === 'https:' && hostMatches(u.hostname, APP_HOSTS);
}

function isInWindowUrl(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  return hostMatches(u.hostname, APP_HOSTS);
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
  ALLOWED_PERMISSIONS,
  isAppUrl,
  isInWindowUrl,
  isGoogleSignIn,
  isExternalSafe,
  hostMatches,
};
