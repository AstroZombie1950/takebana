// Драйвер Chrome поверх DevTools Protocol.
//
// Зачем отдельно от smoke.sh: тот проверяет коды ответов, а страница может
// отдавать честные 200 и при этом не работать. Так и было со страницей эфира —
// весь её JS падал на первой же строке, а curl этого не видел в принципе.
//
// Зависимостей нет: WebSocket встроен в Node начиная с 22-й версии.
// Требуется установленный Chrome и запущенный ops/browser/walk.mjs.

import fs from 'node:fs';

const BASE = `http://127.0.0.1:${process.env.CDP_PORT || 9222}`;

export async function newPage() {
  const t = await (await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
      // alert/confirm блокируют Runtime.evaluate намертво — закрываем сразу,
      // сам факт диалога остаётся в events и попадает в отчёт
      if (m.method === 'Page.javascriptDialogOpening') {
        ws.send(JSON.stringify({ id: 100000 + Math.floor(Math.random() * 10000),
                                 method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      }
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('таймаут ' + method)); } }, 30000);
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  return {
    send, events,
    async goto(url) {
      events.length = 0;
      await send('Page.navigate', { url });
      // ждём срабатывания load, но не висим вечно
      const t0 = Date.now();
      while (Date.now() - t0 < 15000) {
        if (events.some(e => e.method === 'Page.loadEventFired')) break;
        await new Promise(r => setTimeout(r, 200));
      }
      await new Promise(r => setTimeout(r, 1500)); // добор на скрипты и картинки
    },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'ошибка в eval');
      return r.result.value;
    },
    async shot(path, full = true) {
      if (full) {
        const m = await send('Page.getLayoutMetrics');
        const h = Math.min(Math.ceil(m.cssContentSize.height), 6000);
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 1, mobile: false });
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path, Buffer.from(data, 'base64'));
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      return path;
    },
    // Проблемы, которых не видно через curl
    dialogs() {
      return events.filter(e => e.method === 'Page.javascriptDialogOpening')
                   .map(e => e.params.type + ': ' + e.params.message);
    },
    report() {
      const errors = events
        .filter(e => e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type))
        .map(e => e.params.type + ': ' + e.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
      const exceptions = events
        .filter(e => e.method === 'Runtime.exceptionThrown')
        .map(e => 'ИСКЛЮЧЕНИЕ: ' + (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text));
      const failed = events
        .filter(e => e.method === 'Network.loadingFailed')
        .map(e => 'СЕТЬ: ' + e.params.errorText + ' ' + (e.params.type || ''));
      const http = events
        .filter(e => e.method === 'Network.responseReceived' && e.params.response.status >= 400)
        .map(e => 'HTTP ' + e.params.response.status + ' ' + e.params.response.url.replace('http://127.0.0.1:3000', ''));
      return { errors, exceptions, failed, http };
    },
    // закрываем и вкладку: иначе её сокет остаётся в комнате и счётчик зрителей врёт
    close: async () => { ws.close(); await fetch(`${BASE}/json/close/${t.id}`).catch(() => {}); },
  };
}
