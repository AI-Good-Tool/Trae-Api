import crypto from 'node:crypto';
import { gatewayRegion } from './regions.mjs';

export function validateApiKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{16,128}$/.test(value)) {
    throw new Error('API Key 须为 16–128 位字母、数字或 . _ ~ -，不能包含空格');
  }
  return value;
}

export function changeApiKey(store, body) {
  if (body.mode !== 'random' && body.mode !== 'edit') throw new Error('请选择编辑或随机生成');
  const key =
    body.mode === 'random'
      ? `tsk_${crypto.randomBytes(32).toString('hex')}`
      : validateApiKey(body.apiKey);
  const previous = store.data.settings.apiKey;
  store.data.settings.apiKey = key;
  try {
    store.save();
  } catch (error) {
    store.data.settings.apiKey = previous;
    throw error;
  }
  // The key is returned only to this authenticated, explicit action, never in events.
  return { apiKey: key };
}

export async function updateGatewaySettings(store, gateway, body) {
  const previous = store.data.settings;
  const next = { ...previous, gatewayAccountIds: { ...previous.gatewayAccountIds } };
  if (body.gatewayCloudMode !== undefined) {
    if (typeof body.gatewayCloudMode !== 'boolean') throw new Error('云端模式开关无效');
    next.gatewayCloudMode = body.gatewayCloudMode;
  }
  if (body.gatewayVariant !== undefined)
    next.gatewayVariant = gatewayRegion(previous, body.gatewayVariant);
  if (body.gatewayAccountId !== undefined) {
    if (typeof body.gatewayAccountId !== 'string') throw new Error('账号选择无效');
    if (
      body.gatewayAccountId &&
      !['all', store.account(body.gatewayAccountId).variant].includes(next.gatewayVariant)
    ) {
      throw new Error('不能选择其他地区的账号');
    }
    next.gatewayAccountIds[next.gatewayVariant] = body.gatewayAccountId;
  }
  if (body.gatewayMode !== undefined) {
    if (!['round-robin', 'priority', 'random'].includes(body.gatewayMode))
      throw new Error('账号模式无效');
    next.gatewayMode = body.gatewayMode;
  }
  if (body.gatewayPort !== undefined) {
    if (!Number.isInteger(body.gatewayPort) || body.gatewayPort < 1024 || body.gatewayPort > 65535)
      throw new Error('端口应为 1024–65535');
    if (gateway.server && body.gatewayPort !== previous.gatewayPort)
      throw new Error('请先停止反代再修改端口');
    next.gatewayPort = body.gatewayPort;
  }
  if (body.gatewayEnabled !== undefined) {
    if (typeof body.gatewayEnabled !== 'boolean') throw new Error('服务开关无效');
    next.gatewayEnabled = body.gatewayEnabled;
  }
  const wasRunning = !!gateway.server;
  if (next.gatewayCloudMode === false && previous.gatewayCloudMode !== false) {
    try {
      await gateway.ensureModelCatalogs?.(next);
    } catch {
      throw new Error('本地模型目录刷新失败，通道设置未更改，请检查网络或账号凭证后重试');
    }
  }
  store.data.settings = next;
  try {
    if (body.gatewayEnabled !== undefined) {
      if (next.gatewayEnabled) await gateway.start();
      else await gateway.stop();
    }
    store.save();
  } catch (error) {
    store.data.settings = previous;
    if (!wasRunning && gateway.server) await gateway.stop();
    if (wasRunning && !gateway.server) await gateway.start();
    throw error;
  }
  return { ok: true };
}
