// @ts-check
/**
 * 授权接口：查询状态 / 激活 / 取消本机授权。
 *
 * 只有这三个入口，参数都极小；验签在本地完成，不依赖任何远程服务。
 */
import { activateLicense, deactivateLicense, licenseStatus } from '../lib/license.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  /** 当前状态：免费版也返回机器码，用户拿它去买授权 */
  app.get('/api/license', (req, res) => {
    res.json(licenseStatus({ refresh: req.query.refresh === '1' }));
  });

  app.post(
    '/api/license/activate',
    asyncRoute(async (req, res) => {
      const key = String(req.body?.key || '').trim();
      if (!key) return res.status(400).json({ error: '请填写激活码', code: 'license_empty' });
      const r = activateLicense(key);
      if (!r.ok) return res.status(400).json({ error: r.reason, code: 'license_invalid' });
      res.json({ ok: true, ...licenseStatus() });
    })
  );

  app.post(
    '/api/license/deactivate',
    asyncRoute(async (_req, res) => {
      const r = deactivateLicense();
      if (!r.ok) return res.status(500).json({ error: r.reason });
      res.json({ ok: true, ...licenseStatus() });
    })
  );
}
