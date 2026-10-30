import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { readDocument } from '../src/browser.ts';

const PAGE = `<!doctype html><html><body>
<h1>Game manual</h1><p>Press space to jump.</p><div id="x"></div>
<script>document.getElementById('x').textContent = 'Inserted by script';</script>
</body></html>`;

test('readDocument returns the rendered text, including script-inserted text', async () => {
  const server = http.createServer((_req, res) => res.setHeader('content-type', 'text/html').end(PAGE));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const text = await readDocument('chromium', url);
    assert.match(text, /Game manual/);
    assert.match(text, /Press space to jump\./);
    assert.match(text, /Inserted by script/);
  } finally {
    server.close();
  }
});

test('readDocument rejects URLs that are not http(s), including local files', async () => {
  await assert.rejects(readDocument('chromium', 'javascript:alert(1)'), /Only http\(s\) URLs/);
  await assert.rejects(readDocument('chromium', 'file:///etc/hosts'), /Only http\(s\) URLs/);
});
