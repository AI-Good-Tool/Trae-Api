import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appInfo } from './app-info.mjs';
const MAX_BYTES = 512 * 1024 * 1024;
const API = 'https://api.github.com/repos/AI-Good-Tool/Trae-Api/releases/latest';
export function releaseVersion(value) {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
  if (!m || m.slice(1).some((n) => !Number.isSafeInteger(Number(n)))) throw Error('发布版本号无效');
  return m.slice(1).map(Number);
}
export function newerVersion(next, current) {
  const a = releaseVersion(next),
    b = releaseVersion(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export function releaseAssetUrl(raw) {
  const u = new URL(raw);
  if (
    u.protocol !== 'https:' ||
    u.hostname !== 'github.com' ||
    u.port ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    !u.pathname.startsWith('/AI-Good-Tool/Trae-Api/releases/download/')
  )
    throw Error('更新资源地址不属于官方仓库');
  return u.href;
}
export function selectRelease(
  release,
  { platform = process.platform, arch = process.arch, currentVersion = appInfo.version } = {},
) {
  if (release.draft || release.prerelease) throw Error('不支持预发布更新');
  const version = releaseVersion(release.tag_name).join('.');
  const name =
    platform === 'darwin' && ['arm64', 'x64'].includes(arch)
      ? `Trae-Switch-${version}-macOS-${arch}.dmg`
      : platform === 'win32' && arch === 'x64'
        ? `Trae-Switch-${version}-Windows-x64-Setup.exe`
        : null;
  const asset = release.assets?.find((a) => a.name === name);
  if (asset && (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES))
    throw Error('更新安装包大小无效');
  if (asset) releaseAssetUrl(asset.browser_download_url);
  const checksum = release.assets?.find((a) => a.name === name + '.sha256');
  if (checksum) releaseAssetUrl(checksum.browser_download_url);
  const digest = /^sha256:[a-f0-9]{64}$/i.test(asset?.digest || '')
    ? asset.digest.slice(7).toLowerCase()
    : null;
  return {
    version,
    currentVersion,
    target: `${platform}-${arch}`,
    hasUpdate: newerVersion(version, currentVersion),
    canDownload: !!asset && !!(digest || checksum),
    asset: asset
      ? {
          name,
          size: asset.size,
          url: asset.browser_download_url,
          digest,
          checksum: checksum?.browser_download_url,
        }
      : null,
    releaseUrl: appInfo.releases + '/tag/' + encodeURIComponent(release.tag_name),
    notes: String(release.body || '').slice(0, 20000),
  };
}
async function boundedText(response, limit) {
  if (!response.ok) throw Error('更新服务请求失败（HTTP ' + response.status + '）');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      await response.body.cancel().catch(() => {});
      throw Error('更新服务响应过大');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function assetResponse(fetcher, initial, signal) {
  let url = releaseAssetUrl(initial);
  for (let i = 0; i < 6; i++) {
    const response = await fetcher(url, { signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const next = new URL(response.headers.get('location'), url);
    if (
      next.protocol !== 'https:' ||
      next.username ||
      next.password ||
      next.port ||
      ![
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
      ].includes(next.hostname)
    )
      throw Error('更新下载重定向无效');
    url = next.href;
  }
  throw Error('更新下载重定向过多');
}
export class AppUpdater {
  constructor({
    directory,
    platform = process.platform,
    arch = process.arch,
    version = appInfo.version,
    fetcher = fetch,
    onChange = () => {},
    installer = null,
  } = {}) {
    Object.assign(this, { directory, platform, arch, version, fetcher, onChange, installer });
    this.state = {
      status: 'idle',
      currentVersion: version,
      target: `${platform}-${arch}`,
      downloaded: 0,
      total: 0,
      error: null,
      info: null,
      canInstall: !!installer,
    };
  }
  snapshot() {
    return structuredClone(this.state);
  }
  emit(patch) {
    Object.assign(this.state, patch);
    this.onChange(this.snapshot());
  }
  async check() {
    if (this.checking) return this.checking;
    if (['downloading', 'installing', 'ready'].includes(this.state.status)) return this.snapshot();
    this.checking = this.checkImpl().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }
  async checkImpl() {
    this.emit({ status: 'checking', error: null });
    try {
      const r = await this.fetcher(API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Trae-Switch-Updater',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      if (r.status === 404) {
        this.emit({ status: 'unpublished', info: null });
        return this.snapshot();
      }
      const info = selectRelease(JSON.parse(await boundedText(r, 1024 * 1024)), {
        platform: this.platform,
        arch: this.arch,
        currentVersion: this.version,
      });
      this.emit({ status: info.hasUpdate ? 'available' : 'latest', info });
    } catch {
      this.emit({
        status: 'error',
        error: '检查更新失败，请检查网络或稍后重试（GitHub 可能限流）',
      });
    }
    return this.snapshot();
  }
  async download() {
    if (this.checking || ['downloading', 'installing'].includes(this.state.status))
      throw Error('已有更新任务正在进行');
    const info = this.state.info;
    if (!info?.hasUpdate || !info.canDownload || !this.directory || !this.installer)
      throw Error('没有可在当前应用安装的更新包');
    if (this.state.status === 'ready') return this.snapshot();
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15 * 60 * 1000)]);
    this.emit({ status: 'downloading', downloaded: 0, total: info.asset.size, error: null });
    let partial;
    try {
      let expected = info.asset.digest;
      if (!expected) {
        const text = await boundedText(
          await assetResponse(this.fetcher, info.asset.checksum, signal),
          4096,
        );
        const m = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(text.trim());
        if (!m || m[2] !== info.asset.name) throw Error('更新校验文件无效');
        expected = m[1].toLowerCase();
      }
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const folder = fs.mkdtempSync(path.join(this.directory, 'download-'));
      partial = path.join(folder, 'payload.part');
      const response = await assetResponse(this.fetcher, info.asset.url, signal);
      if (!response.ok) throw Error('更新下载失败（HTTP ' + response.status + '）');
      const hash = crypto.createHash('sha256');
      const file = fs.openSync(partial, 'wx', 0o600);
      let bytes = 0,
        notified = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          bytes += chunk.length;
          if (bytes > info.asset.size || bytes > MAX_BYTES)
            throw Error('更新安装包大小与发布记录不符');
          hash.update(chunk);
          fs.writeFileSync(file, chunk);
          if (Date.now() - notified > 150) {
            this.emit({ downloaded: bytes });
            notified = Date.now();
          }
        }
      } finally {
        fs.closeSync(file);
      }
      signal.throwIfAborted();
      if (bytes !== info.asset.size || hash.digest('hex') !== expected)
        throw Error('更新安装包完整性校验失败，请重新下载');
      const ready = path.join(folder, info.asset.name);
      fs.renameSync(partial, ready);
      partial = null;
      this.ready = { file: ready, digest: expected, info };
      this.emit({ status: 'ready', downloaded: bytes });
    } catch (e) {
      if (partial) fs.rmSync(partial, { force: true });
      const cancelled = this.controller.signal.aborted;
      this.emit({
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled
          ? null
          : '下载失败：' +
            ([
              '更新校验文件无效',
              '更新安装包大小与发布记录不符',
              '更新安装包完整性校验失败，请重新下载',
            ].includes(e.message)
              ? e.message
              : '网络连接异常或更新资源不可用，请重试'),
      });
    } finally {
      this.controller = null;
    }
    return this.snapshot();
  }
  cancel() {
    this.controller?.abort();
    return this.snapshot();
  }
  async install() {
    if (this.state.status !== 'ready' || !this.ready || !this.installer)
      throw Error('请先下载并校验更新');
    this.emit({ status: 'installing', error: null });
    try {
      const realRoot = fs.realpathSync(this.directory),
        realFile = fs.realpathSync(this.ready.file);
      if (
        !realFile.startsWith(realRoot + path.sep) ||
        fs.lstatSync(this.ready.file).isSymbolicLink() ||
        fs.statSync(realFile).size !== this.ready.info.asset.size
      )
        throw Error('更新文件路径无效');
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(realFile)) hash.update(chunk);
      if (hash.digest('hex') !== this.ready.digest) throw Error('更新文件已被修改，请重新下载');
      await this.installer({ ...this.ready, file: realFile });
    } catch (e) {
      this.emit({ status: 'error', error: e.message });
      throw e;
    }
    return this.snapshot();
  }
}
