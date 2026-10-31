import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { ConfigError, deepMerge, listCampaigns, loadConfig, localConfigPath, parseConfigText, resolveCampaign } from '../src/config.ts';
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

test('YAML merge keys work, so a campaign can reuse a model block', () => {
  const file = parseConfigText('x-models: &m { provider: codex, name: a }\ncampaigns:\n  c:\n    url: https://example.com/\n    instructions: Play.\n    model: { <<: *m, name: b }\n', 'merge.yaml');
  const c = resolveCampaign(file, 'c', '/base');
  assert.equal(c.model.provider, 'codex');
  assert.equal(c.model.name, 'b');
});

test('a local overlay next to the config adds campaigns and overrides defaults and campaigns', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'game-r.yaml');
  assert.equal(localConfigPath(file), path.join(dir, 'game-r.local.yaml'));
  await writeFile(file, YAML);
  assert.deepEqual(await listCampaigns(file), ['a', 'b', 'bad']);
  assert.equal((await loadConfig(file, 'a')).notify.command, null);
  await writeFile(
    path.join(dir, 'game-r.local.yaml'),
    `defaults:\n  notify: { command: 'echo hi' }\ncampaigns:\n  a: { limits: { hours: 1 } }\n  mine: { url: https://example.com/, instructions: Mine. }\n`,
  );
  assert.deepEqual(await listCampaigns(file), ['a', 'b', 'bad', 'mine']);
  const a = await loadConfig(file, 'a');
  assert.equal(a.notify.command, 'echo hi');
  assert.equal(a.limits.hours, 1);
  assert.equal(a.limits.runs, 3, 'the shipped defaults still apply');
  assert.equal(a.browser.headless, false, 'the shipped campaign keeps what the overlay does not set');
  assert.equal((await loadConfig(file, 'mine')).model.name, 'claude-opus-5-5');
  await writeFile(path.join(dir, 'game-r.local.yaml'), 'x-shared: { a: 1 }\ndefault: { limits: { runs: 1 } }\n');
  await assert.rejects(loadConfig(file, 'a'), /game-r\.local\.yaml: unknown top-level key default/);
  await writeFile(path.join(dir, 'game-r.local.yaml'), 'campaigns: [oops');
  await assert.rejects(loadConfig(file, 'a'), (err: Error) => err instanceof ConfigError && err.message.includes('game-r.local.yaml'));
});
