// 生成 / 复用本地开发者密钥对。
// 私钥只写入 .keys/dev-private.pem（.gitignore 忽略，绝不提交）；
// 公钥写入 src/dev-public-key.js（公钥可以公开，服务端用它验签）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PAYLOAD = 'turtle-soup-dev-panel-v1';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyDir = path.join(root, '.keys');
const privPath = path.join(keyDir, 'dev-private.pem');
const tokenPath = path.join(keyDir, 'dev-token.txt');
const pubModule = path.join(root, 'src', 'dev-public-key.js');

fs.mkdirSync(keyDir, { recursive: true });

let privateKey;
if (fs.existsSync(privPath)) {
  privateKey = crypto.createPrivateKey(fs.readFileSync(privPath, 'utf8'));
  console.log('[dev] 复用已有私钥：' + privPath);
} else {
  privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('[dev] 已生成新的 Ed25519 私钥：' + privPath);
}

const publicKey = crypto.createPublicKey(privateKey);
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
fs.writeFileSync(
  pubModule,
  '// 由 npm run dev:keygen 生成：Ed25519 公钥（256 位安全强度）。\n' +
    '// 私钥在本地 .keys/dev-private.pem，绝不入库。\n' +
    'export const DEV_PUBLIC_KEY = \`' + publicPem + '\`;\n'
);

const token = crypto.sign(null, Buffer.from(PAYLOAD), privateKey).toString('base64url');
fs.writeFileSync(tokenPath, token + '\n');
console.log('[dev] 公钥已写入 src/dev-public-key.js');
console.log('[dev] 登录令牌（复制到 /dev 页面）：');
console.log(token);
