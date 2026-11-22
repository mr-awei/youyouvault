/**
 * 等本地 API 就绪后再启动 Electron。
 *
 * 图库大（几万张）时后端要建索引、加载 AI 模型，20–40 秒都有可能。
 * 如果窗口先打开，首屏会一次性打出一屏 ECONNREFUSED（Vite 代理报错），
 * 看起来像“dev 启动大量报错”，其实只是后端还没监听端口。
 *
 * 用 node:http 而不是 fetch：Windows 上 fetch 的 keep-alive 句柄在
 * process.exit 时可能触发 libuv 断言，改成短连接后让进程自然退出。
 */
import http from 'node:http';

const base = (process.env.TUKU_API_PROXY || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const timeoutMs = Number(process.env.TUKU_WAIT_API_MS || 180000);
const deadline = Date.now() + timeoutMs;

/** 单次探活：2 秒超时，失败按未就绪处理 */
function alive() {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/health`, { agent: false, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

let ready = false;
while (Date.now() < deadline) {
  if (await alive()) {
    ready = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

if (!ready) {
  console.error(`[dev] 等待后端超时（${base}，${Math.round(timeoutMs / 1000)}s），请检查 server 日志`);
  process.exitCode = 1;
}
