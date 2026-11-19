import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { desktop, onApiError } from '../api';
import type { ImageItem, View } from '../types';
import { queueCanvasAdd } from '../lib/canvas-board';
import { subscribeEvents } from '../events';
import type { Toast } from './types';
import i18n from '../i18n';

type Options = {
  setLoadError: Dispatch<SetStateAction<string>>;
  showToast: Toast;
  setServiceRestarting: Dispatch<SetStateAction<boolean>>;
  setServiceOffline: Dispatch<SetStateAction<boolean>>;
  setServiceError: Dispatch<SetStateAction<string>>;
  setView: Dispatch<SetStateAction<View>>;
  setFolderId: Dispatch<SetStateAction<number | null>>;
  openItem: (item: ImageItem, pool?: ImageItem[], full?: boolean) => void;
};

/**
 * 应用级「服务与跨页面事件」接线：
 * 后台请求失败收口 / 本地服务状态 / 事件回调异常 toast / 在图库中定位。
 *
 * 各 effect 的顺序与拆分前一致（业务代码里它们本来就是连着的一段）。
 */
export function useAppServices({
  setLoadError,
  showToast,
  setServiceRestarting,
  setServiceOffline,
  setServiceError,
  setView,
  setFolderId,
  openItem,
}: Options) {
  // 后台请求失败统一收口：同一条错误只显示一次，用户关掉后不再反复弹
  useEffect(() => onApiError((err) => setLoadError((prev) => prev || err.message)), [setLoadError]);

  // 本地服务重启：先遮住，恢复后主进程会重载页面，遮罩自然消失
  useEffect(() => {
    if (!desktop?.onServiceState) return;
    // 只清除「服务状态」自己写入的那条错误，别把真正的数据错误一起吞掉
    let serviceErr = '';
    return desktop.onServiceState((s) => {
      setServiceRestarting(!!s.restarting);
      // dead 态不遮罩锁死，但要常驻一条离线横幅，别让用户对着「点不动」猜原因
      setServiceOffline(!!s.dead);
      setServiceError(String(s.error || ''));
      if (s.error) {
        serviceErr = i18n.t('kc409134c', { p0: s.error });
        setLoadError(serviceErr);
      } else if (serviceErr && !s.restarting && !s.dead) {
        setLoadError((prev) => (prev === serviceErr ? '' : prev));
        serviceErr = '';
      }
    });
  }, [setLoadError, setServiceError, setServiceOffline, setServiceRestarting]);

  /* 事件回调里抛的错（定时器、onClick 里的 await）到不了 React 错误边界，
     由 main.tsx 统一转成 tuku:error，这里用 toast 让用户至少知道「刚才那下失败了」 */
  useEffect(() => {
    const onErr = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (typeof msg === 'string' && msg) showToast(i18n.t('k3f19d5cc', { p0: msg }), 'error');
    };
    window.addEventListener('tuku:error', onErr);
    return () => window.removeEventListener('tuku:error', onErr);
  }, [showToast]);

  /* 「在图库中定位」：切回图库、把筛选切到它所在的文件夹。
     时间线只要求「用图库打开所在文件夹」，传 openImage:false 就不弹大图。 */
  useEffect(() => {
    const onLocate = (e: Event) => {
      const d = (e as CustomEvent<{ item?: ImageItem; folderId?: number | null; openImage?: boolean }>).detail;
      if (!d || !d.item) return;
      setView('gallery');
      setFolderId(d.folderId ?? null);
      if (d.openImage !== false) openItem(d.item, [d.item]);
    };
    window.addEventListener('tuku:locate-image', onLocate);
    return () => window.removeEventListener('tuku:locate-image', onLocate);
  }, [openItem, setFolderId, setView]);

  /* 「加入画布」：图库选中项先暂存 id，再切到画布；画布挂载后取走并摆放到视口中心 */
  useEffect(() => {
    const onAdd = (e: Event) => {
      const d = (e as CustomEvent<{ ids?: number[] }>).detail;
      const ids = Array.isArray(d?.ids) ? d.ids : [];
      if (ids.length) queueCanvasAdd(ids);
      setView('canvas');
    };
    window.addEventListener('tuku:canvas-add', onAdd);
    return () => window.removeEventListener('tuku:canvas-add', onAdd);
  }, [setView]);

  /* 批量入库勾了「存入画布」：服务端推来新入库 id；先入队，画布开着就即时落上去 */
  useEffect(
    () =>
      subscribeEvents('canvas', (d: { ids?: number[] }) => {
        const ids = Array.isArray(d?.ids) ? d.ids.map(Number).filter((n) => n > 0) : [];
        if (!ids.length) return;
        queueCanvasAdd(ids);
        window.dispatchEvent(new CustomEvent('tuku:canvas-push', { detail: { ids } }));
        showToast(i18n.t('k7c3f1a4f', { p0: ids.length }));
      }),
    [showToast]
  );

}
