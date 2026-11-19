// @ts-check
/**
 * 插件 / 脚本宿主路由：清单发现、试运行、启用停用与卸载。
 * 执行放在独立子进程里（见 lib/plugin-host.js），这里只做参数校验与结果转发。
 */
import { openFolder } from '../desktop.js';
import { PLUGIN_PERMISSIONS } from '../lib/plugin-manifest.js';
import { translate } from '../lib/i18n.js';
import { requirePro } from '../lib/license.js';
import {
  ensureUserPluginDir,
  listPlugins,
  runPlugin,
  setPluginEnabled,
  uninstallPlugin,
} from '../lib/plugin-host.js';

const publicView = (p) => ({
  id: p.id,
  // 插件清单里的名称 / 说明是随包中文文案，展示层按语言翻译（插件 id 与目录不受影响）
  name: translate(p.name),
  version: p.version,
  description: translate(p.description),
  permissions: p.permissions,
  actions: p.actions,
  builtin: p.builtin,
  enabled: p.enabled !== false,
});

/** 安装失败一律给明确原因，不静默吞掉 */
function fail(res, err, status = 400) {
  return res.status(status).json({ error: String(err?.message || err).slice(0, 300) });
}

export function register(app, ctx) {
  const { asyncRoute } = ctx;

  app.get('/api/plugins', (_req, res) => {
    res.json({ ok: true, plugins: listPlugins().map(publicView), permissions: PLUGIN_PERMISSIONS });
  });

  /** 启用 / 停用：不解包、不卸载，只记库级开关；停用后执行直接拒绝 */
  app.patch('/api/plugins/:id', (req, res) => {
    try {
      const enabled = req.body?.enabled !== false;
      const r = setPluginEnabled(req.params.id, enabled);
      res.json({ ok: true, ...r });
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete(
    '/api/plugins/:id',
    asyncRoute(async (req, res) => {
      try {
        res.json(await uninstallPlugin(String(req.params.id)));
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  // 没有单条查询接口：列表已返回全部字段，多一个「只读一条」既没人调用，
  // 又和列表的返回值必须永远保持一致，纯粹是维护负担。

  app.post(
    '/api/plugins/:id/run',
    // 插件脚本是专业版能力；清单与启停仍开放，免费版可以看有哪些插件
    requirePro('plugins'),
    asyncRoute(async (req, res) => {
      const body = req.body || {};
      const imageId = Number(body.imageId) || null;
      const r = await runPlugin({
        id: String(req.params.id),
        action: String(body.action || 'run'),
        imageId,
        args: body.args,
      });
      if (!r.ok) return res.status(400).json({ error: r.error });
      res.json({ ok: true, ...r });
    })
  );

  app.post(
    '/api/plugins/open-folder',
    asyncRoute(async (_req, res) => {
      const dir = await ensureUserPluginDir();
      await openFolder(dir);
      res.json({ ok: true, dir });
    })
  );
}
