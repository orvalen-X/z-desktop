'use strict';
// Diagnostic only (never merged): the real app in span mode on Windows, F11 out and back, with and without the hold.
const { app, session, net, BaseWindow, webContents } = require('electron');
const fs = require('fs'); const path = require('path');
const UD = path.join(process.env.RUNNER_TEMP || __dirname, 'zs-ud-' + (process.env.DIAG_KEYS || '1'));
fs.mkdirSync(UD, { recursive: true });
fs.writeFileSync(path.join(UD, 'z-desktop.json'), JSON.stringify({ span: true, winKeys: process.env.DIAG_KEYS !== '0' }));
app.setPath('userData', UD);
const page = `<!doctype html><html><body style="background:#00aa00;margin:0"><h1 id=h>Z</h1><script>
document.addEventListener('fullscreenchange',()=>{console.log('fsc '+!!document.fullscreenElement+' '+innerWidth+'x'+innerHeight);if(document.fullscreenElement)navigator.keyboard.lock(['MetaLeft','MetaRight','Tab','Escape']).then(()=>console.log('lock ok'),e=>console.log('lock err '+e))});
let n=0;setInterval(()=>{document.getElementById('h').textContent='Z '+(n++)},250);
</script></body></html>`;
const log = (...a) => console.log('[diag]', new Date().toISOString().slice(11, 23), ...a);
app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', (req) => new URL(req.url).hostname === 'orvalen.me' ? new Response(page, { headers: { 'content-type': 'text/html' } }) : net.fetch(req, { bypassCustomProtocolHandlers: true }));
  const z = () => webContents.getAllWebContents().find((w) => w.getURL().startsWith('https://orvalen.me'));
  const dump = async (tag) => {
    for (const b of BaseWindow.getAllWindows()) log(tag, 'win', JSON.stringify(b.getBounds()), 'fs', b.isFullScreen(), 'visible', b.isVisible(), 'min', b.isMinimized(), 'top', b.isAlwaysOnTop(), 'focused', b.isFocused(), 'kiosk', b.isKiosk && b.isKiosk(), 'views', b.contentView.children.map((v) => JSON.stringify(v.getBounds()) + ' vis=' + (v.getVisible ? v.getVisible() : '?') + (v.webContents ? ' ' + v.webContents.getURL().slice(0, 24) : '')).join(' ; '));
    const w = z();
    if (w) {
      const t0 = Date.now();
      const r = await Promise.race([w.executeJavaScript('document.getElementById("h").textContent + " fs=" + !!document.fullscreenElement + " " + innerWidth + "x" + innerHeight'), new Promise((res) => setTimeout(() => res('NO ANSWER (hung?)'), 3000))]);
      log(tag, 'page says', r, (Date.now() - t0) + 'ms', 'crashed', w.isCrashed());
      try { const img = await w.capturePage(); const bm = img.toBitmap(); const s = img.getSize(); const px = (x, y) => { const i = (y * s.width + x) * 4; return bm[i + 2] + ',' + bm[i + 1] + ',' + bm[i]; }; log(tag, 'capture', JSON.stringify(s), 'center', px(s.width >> 1, s.height >> 1)); } catch (e) { log(tag, 'capture err', String(e)); }
    }
    fs.writeFileSync(path.join(process.env.RUNNER_TEMP || __dirname, 'diag-step.txt'), tag);
  };
  const press = (k) => { const w = z(); w.sendInputEvent({ type: 'keyDown', keyCode: k }); w.sendInputEvent({ type: 'keyUp', keyCode: k }); };
  setTimeout(() => dump('start'), 6000);
  setTimeout(() => { log('F11 out'); press('F11'); }, 9000);
  setTimeout(() => dump('windowed'), 11000);
  setTimeout(() => { log('F11 in'); press('F11'); }, 16000);
  setTimeout(() => dump('full-again'), 18000);
  setTimeout(() => dump('full-again+3'), 21000);
  setTimeout(() => app.quit(), 25000);
});
app.on('browser-window-created', () => {});
setTimeout(() => { for (const b of BaseWindow.getAllWindows()) for (const n of ['show', 'hide', 'minimize', 'restore', 'blur', 'focus', 'enter-full-screen', 'leave-full-screen', 'resize', 'move', 'always-on-top-changed']) b.on(n, () => log('WIN', n, JSON.stringify(b.getBounds()))); }, 5000);
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (ev) => log('PAGE', ev.message));
  for (const n of ['enter-html-full-screen', 'leave-html-full-screen', 'render-process-gone', 'unresponsive', 'responsive']) wc.on(n, () => log('EV', wc.id, n));
});
require('../src/main.js');
