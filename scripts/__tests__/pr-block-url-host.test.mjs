// pr-block --url 只放行 XD Sites 部署域（迁移前后两个域都认，含子域）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PR_BLOCK = fileURLToPath(new URL('../pr-block.mjs', import.meta.url));
const run = (url) => spawnSync(process.execPath, [PR_BLOCK, '--demo', '/nonexistent-qa-demo', '--url', url], {
  encoding: 'utf8',
  env: { ...process.env, QA_HIFI_URL_ALLOW: '' },
});

test('拒绝非部署域', () => {
  const r = run('https://demo.example.com');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--url 只允许 workers\.xd\.team \/ workers\.xd-sites\.com/);
});

test('放行迁移前后两个部署域的子域', () => {
  for (const url of ['https://pr-demos.workers.xd-sites.com/cindy-x/index.html', 'https://demo.workers.xd.team']) {
    const r = run(url);
    assert.doesNotMatch(r.stderr, /--url 只允许/, url);
  }
});
