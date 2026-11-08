// 开发者面板：Ed25519 公钥验签 + 内存会话。
// 私钥只保存在开发者本机（.keys/dev-private.pem），仓库与服务端只有公钥。
import crypto from 'node:crypto';
import { DEV_PUBLIC_KEY } from './dev-public-key.js';

export const DEV_PAYLOAD = 'turtle-soup-dev-panel-v1';
const SESSION_MS = 2 * 60 * 60 * 1000;
const COOKIE = 'ts_dev';
const sessions = new Map();

function prune() {
  const t = Date.now();
  for (const [id, exp] of sessions) if (exp <= t) sessions.delete(id);
}

// 校验“用本地私钥对固定 payload 签名”得到的开发者令牌
export function verifyDevToken(token) {
  try {
    const sig = Buffer.from(String(token || '').trim(), 'base64url');
    if (sig.length !== 64) return false; // Ed25519 签名固定 64 字节
    return crypto.verify(null, Buffer.from(DEV_PAYLOAD), DEV_PUBLIC_KEY, sig);
  } catch {
    return false;
  }
}

export function readCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

export function startDevSession(req, res) {
  prune();
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, Date.now() + SESSION_MS);
  const secure = req.secure || String(req.headers['x-forwarded-proto'] || '').includes('https');
  res.setHeader(
    'Set-Cookie',
    COOKIE + '=' + id + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + Math.floor(SESSION_MS / 1000) + (secure ? '; Secure' : '')
  );
  return id;
}

export function endDevSession(req, res) {
  const id = readCookie(req, COOKIE);
  if (id) sessions.delete(id);
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
}

export function isDev(req) {
  prune();
  const id = readCookie(req, COOKIE);
  if (!id) return false;
  const exp = sessions.get(id);
  if (!exp || exp <= Date.now()) {
    sessions.delete(id);
    return false;
  }
  sessions.set(id, Date.now() + SESSION_MS); // 访问即续期
  return true;
}

export function requireDev(req, res, next) {
  if (isDev(req)) return next();
  res.status(401).json({ error: '需要开发者权限，请先在 /dev 输入开发者密钥登录' });
}
