/**
 * 「服务端能自己生成缩略图」的素材类型。
 *
 * sharp / 内嵌预览只能处理位图、GIF、RAW 和设计稿；Office、PDF、音视频、字体、3D
 * 的 `/api/images/:id/thumb` 在没有用户手动设封面时只会回 404。前端这些地方
 * 应该直接画类型占位卡，而不是先发一个注定失败的 <img> 请求 —— 否则控制台和
 * 网络面板里全是没意义的 404，真正的错误反而被淹掉。
 */
const SERVER_THUMB_KINDS = new Set(['image', 'gif', 'raw', 'design']);

/** kind 缺省时按位图处理（历史数据没有 media_kind 字段） */
export function hasServerThumb(kind?: string | null): boolean {
  return SERVER_THUMB_KINDS.has(String(kind || 'image'));
}
