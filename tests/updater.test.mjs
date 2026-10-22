import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { AppUpdater, selectRelease, newerVersion, releaseAssetUrl } from '../server/updater.mjs';
import { bundlePath } from '../server/update-install.mjs';
const bytes = Buffer.from('test installer bytes');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const root = 'https://github.com/AI-Good-Tool/Trae-Api/releases/download/v0.9.0/';
function release() {
  return {
    tag_name: 'v0.9.0',
    body: 'Release notes',
    assets: [
      {
        name: 'Trae-Switch-0.9.0-macOS-arm64.dmg',
        size: bytes.length,
        browser_download_url: root + 'Trae-Switch-0.9.0-macOS-arm64.dmg',
        digest: 'sha256:' + digest,
      },
      {
        name: 'Trae-Switch-0.9.0-Windows-x64-Setup.exe',
        size: bytes.length,
        browser_download_url: root + 'Trae-Switch-0.9.0-Windows-x64-Setup.exe',
        digest: 'sha256:' + digest,
      },
    ],
  };
}
function setup(fetcher, installer = async () => {}) {
  return new AppUpdater({
    directory: fs.mkdtempSync(path.join(os.tmpdir(), 'trae-update-test-')),
    platform: 'darwin',
    arch: 'arm64',
    version: '0.8.0',
    fetcher,
    installer,
  });
}
test('更新匹配语义版本与系统架构，不混用 Intel、ARM、便携包或预发布', () => {
  assert(newerVersion('v0.10.0', '0.9.9'));
  assert(!newerVersion('0.8.0', '0.8.0'));
  assert.throws(() => newerVersion('v1.0.0-beta', '0.8.0'));
  assert(
    selectRelease(release(), { platform: 'darwin', arch: 'arm64', currentVersion: '0.8.0' })
      .canDownload,
  );
  assert(
    !selectRelease(release(), { platform: 'darwin', arch: 'x64', currentVersion: '0.8.0' })
      .canDownload,
  );
  assert(
    selectRelease(release(), {
      platform: 'win32',
      arch: 'x64',
      currentVersion: '0.8.0',
    }).asset.name.endsWith('Setup.exe'),
  );
  assert.throws(() => selectRelease({ ...release(), prerelease: true }));
  for (const url of [
    'http://github.com/AI-Good-Tool/Trae-Api/releases/download/v1/a',
    'https://github.com/other/Trae-Api/releases/download/v1/a',
    'https://evil.invalid/file',
    'https://user@github.com/AI-Good-Tool/Trae-Api/releases/download/v1/a',
  ])
    assert.throws(() => releaseAssetUrl(url));
  assert.equal(
    bundlePath('/Applications/Trae Switch.app/Contents/MacOS/Trae Switch'),
    '/Applications/Trae Switch.app',
  );
  assert.throws(() => bundlePath('/Volumes/Trae/Trae Switch.app/Contents/MacOS/Trae Switch'));
});
test('下载完整性验证、单任务锁、安装前重验及篡改拒绝', async () => {
  let installed = 0;
  const updater = setup(
    async (url) =>
      url.includes('api.github.com') ? Response.json(release()) : new Response(bytes),
    async () => installed++,
  );
  await updater.check();
  assert.equal(updater.state.status, 'available');
  await updater.download();
  assert.equal(updater.state.status, 'ready');
  await updater.install();
  assert.equal(installed, 1);
  const corrupted = setup(async (url) =>
    url.includes('api.github.com') ? Response.json(release()) : new Response(bytes),
  );
  await corrupted.check();
  await corrupted.download();
  fs.writeFileSync(corrupted.ready.file, Buffer.alloc(bytes.length));
  await assert.rejects(corrupted.install(), /已被修改/);
  assert.equal(corrupted.state.status, 'error');
  const bad = setup(async (url) =>
    url.includes('api.github.com')
      ? Response.json(release())
      : new Response(Buffer.alloc(bytes.length)),
  );
  await bad.check();
  await bad.download();
  assert.equal(bad.state.status, 'error');
  assert(!bad.ready);
  assert(!fs.readdirSync(bad.directory, { recursive: true }).some((f) => f.endsWith('.part')));
});
test('取消下载和网络失败可重试，无发布不误报最新版，检查合并并发请求', async () => {
  let checks = 0;
  const updater = setup(async (url, options) => {
    if (url.includes('api.github.com')) {
      checks++;
      return Response.json(release());
    }
    return new Promise((_, reject) =>
      options.signal.addEventListener('abort', () => reject(Error('aborted')), { once: true }),
    );
  });
  await Promise.all([updater.check(), updater.check()]);
  assert.equal(checks, 1);
  const download = updater.download();
  await assert.rejects(updater.download(), /正在进行/);
  updater.cancel();
  await download;
  assert.equal(updater.state.status, 'cancelled');
  const empty = setup(async () => new Response('', { status: 404 }));
  await empty.check();
  assert.equal(empty.state.status, 'unpublished');
  const unavailable = setup(async () => new Response('', { status: 403 }));
  await unavailable.check();
  assert.equal(unavailable.state.status, 'error');
  const browser = setup(async () => Response.json(release()), null);
  await browser.check();
  await assert.rejects(browser.download(), /没有可/);
});
test('SHA-256 sidecar fallback validates filename and prevents checksum confusion', async () => {
  const data = release();
  delete data.assets[0].digest;
  data.assets.push({
    name: data.assets[0].name + '.sha256',
    browser_download_url: root + data.assets[0].name + '.sha256',
  });
  const updater = setup(async (url) =>
    url.includes('api.github.com')
      ? Response.json(data)
      : url.endsWith('.sha256')
        ? new Response(digest + '  ' + data.assets[0].name + '\n')
        : new Response(bytes),
  );
  await updater.check();
  await updater.download();
  assert.equal(updater.state.status, 'ready');
});

test('下载拒绝非 GitHub CDN 重定向和超量数据，安装拒绝目录外文件', async () => {
  const redirected = setup(async (url) =>
    url.includes('api.github.com')
      ? Response.json(release())
      : new Response(null, {
          status: 302,
          headers: { location: 'https://untrusted.invalid/file' },
        }),
  );
  await redirected.check();
  await redirected.download();
  assert.equal(redirected.state.status, 'error');
  const oversized = setup(async (url) =>
    url.includes('api.github.com')
      ? Response.json(release())
      : new Response(Buffer.alloc(bytes.length + 1)),
  );
  await oversized.check();
  await oversized.download();
  assert.equal(oversized.state.status, 'error');
  const updater = setup(async (url) =>
    url.includes('api.github.com') ? Response.json(release()) : new Response(bytes),
  );
  await updater.check();
  await updater.download();
  const outside = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'trae-outside-update-')),
    'installer',
  );
  fs.writeFileSync(outside, bytes);
  updater.ready.file = outside;
  await assert.rejects(updater.install(), /路径无效/);
});
