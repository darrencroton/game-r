import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, deepMerge, parseConfigText, resolveCampaign } from '../src/config.ts';
import { apiKey, FatalModelError } from '../src/model.ts';
import { makeConfig, tempDir } from './helpers.ts';

const YAML = `
defaults:
  model: { name: claude-opus-5-5, price_per_mtok: { input: 5, output: 25 } }
  browser: { device: "Pixel 7" }
  limits: { runs: 3 }
campaigns:
  a:
    url: https://example.com/game/
    instructions: Play.
    browser: { headless: false }
  b:
    url: ./local/index.html
    instructions: Test.
    model: { name: claude-sonnet-5-5 }
    limits: { runs: null, hours: 2 }
  bad:
    url: https://example.com/
    instructions: x
    access: root
`;

test('campaigns inherit defaults and override only what they set', () => {
  const file = parseConfigText(YAML, 'test.yaml');
  const a = resolveCampaign(file, 'a', '/base');
  assert.equal(a.browser.device, 'Pixel 7');
  assert.equal(a.browser.headless, false);
  assert.equal(a.browser.engine, 'chromium');
  assert.equal(a.model.name, 'claude-opus-5-5');
  assert.deepEqual(a.model.price_per_mtok, { input: 5, output: 25 });
  assert.equal(a.limits.runs, 3);
  assert.equal(a.limits.hours, 48);
  assert.equal(a.output, path.resolve('/base', 'runs'));
  assert.equal(a.model.secrets_file, path.resolve('/base', '.env'));

  const b = resolveCampaign(file, 'b', '/base');
  assert.equal(b.model.name, 'claude-sonnet-5-5');
  assert.deepEqual(b.model.price_per_mtok, { input: 5, output: 25 });
  assert.equal(b.limits.runs, null);
  assert.equal(b.limits.hours, 2);
  assert.equal(b.url, 'file:///base/local/index.html');
});

test('invalid values and unknown campaigns give readable errors', () => {
  const file = parseConfigText(YAML, 'test.yaml');
  assert.throws(() => resolveCampaign(file, 'bad', '/base'), (err: Error) => err instanceof ConfigError && /access/.test(err.message));
  assert.throws(() => resolveCampaign(file, 'nope', '/base'), /Known: a, b, bad/);
  assert.throws(() => parseConfigText('campaigns: [1, 2', 'x.yaml'), /invalid YAML/);
});

test('deepMerge merges objects and replaces arrays', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } }), { a: { b: 1, c: [3] } });
});

test('API keys come from the environment first, then the secrets file', async () => {
  const dir = await tempDir();
  const secrets_file = path.join(dir, '.env');
  await writeFile(secrets_file, '# keys\nEMPTY= \nTEST_FILE_KEY="from-file"\nOTHER=x\n');
  const model = (await makeConfig({ model: { api_key_env: 'TEST_FILE_KEY', secrets_file } })).model;
  assert.equal(apiKey(model), 'from-file');
  process.env.TEST_FILE_KEY = 'from-env';
  try {
    assert.equal(apiKey(model), 'from-env');
  } finally {
    delete process.env.TEST_FILE_KEY;
  }
  assert.throws(() => apiKey({ ...model, api_key_env: 'TEST_MISSING_KEY' }), (err: Error) => err instanceof FatalModelError && err.message.includes(secrets_file));
  assert.throws(() => apiKey({ ...model, secrets_file: path.join(dir, 'none.env') }), /Add TEST_FILE_KEY=/);
  assert.equal(apiKey({ ...model, api_key_env: null }), null);
});
