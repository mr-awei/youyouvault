// @ts-check
/**
 * OMS 账号与查询接口。
 * 账号密码只落在本机 data 目录，接口只回配置状态与查询结果，永远不回密码。
 */
import { omsClient } from '../lib/oms.js';

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get(
    '/api/oms/status',
    asyncRoute(async (_req, res) => {
      res.json(await omsClient.status());
    })
  );

  /* 保存账号：先登录验证，成功才落盘 */
  app.post(
    '/api/oms/account',
    asyncRoute(async (req, res) => {
      try {
        const status = await omsClient.saveAccount({
          username: req.body?.username,
          password: req.body?.password,
          baseUrl: req.body?.baseUrl,
        });
        res.json(status);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  /* 测试已有账号：强制重新登录一次 */
  app.post(
    '/api/oms/login',
    asyncRoute(async (_req, res) => {
      try {
        await omsClient.login(true);
        res.json(await omsClient.status());
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    })
  );

  app.delete(
    '/api/oms/account',
    asyncRoute(async (_req, res) => {
      res.json(await omsClient.clearAccount());
    })
  );

  /* 批量按 5 位主 SKU 查待拍摄完整编码 */
  app.post(
    '/api/oms/resolve',
    asyncRoute(async (req, res) => {
      const status = await omsClient.status();
      if (!status.configured) {
        return res.status(400).json({ error: '尚未配置 OMS 账号', code: 'oms_not_configured' });
      }
      const raw = Array.isArray(req.body?.skus) ? req.body.skus : [];
      const skus = raw.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 50);
      if (!skus.length) return res.status(400).json({ error: '没有需要查询的主 SKU' });
      const results = await omsClient.resolveMany(skus);
      res.json({ results });
    })
  );
}
