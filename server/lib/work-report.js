// @ts-check
/**
 * 工作日报 xlsx 生成。
 *
 * 版式以人工核对过的模板为准：
 * - 不输出表头：第一行就是数据，所有单元格水平 + 垂直居中
 * - 日期、今日完成工作、总工作时长、进度百分比、工作成果 纵向合并到最后一行（含「图片上传」行）
 * - 拍摄时长、包装/安装/拆卸 只合并到最后一条产品行
 * - 图片上传写在 SKU 列，类别为「其它」
 * - 末尾保留一行空行；所有数据行行高 15
 *
 * 列顺序（共 11 列，中间不再留空列）：
 *   A 日期 | B 今日完成工作 | C SKU | D 品名 | E 平台 | F 类别 |
 *   G 拍摄时长 | H 包装/安装/拆卸 | I 总工作时长 | J 进度 | K 文件夹截图
 *
 * 注意：这里用 xlsx-js-style 而不是 xlsx，因为社区版 xlsx 写文件会丢掉样式；
 * 模板里的居中与合并都依赖样式信息。
 */
import XLSX from 'xlsx-js-style';

const COLS = 11;
/** 全表统一居中（与用户确认的版式一致）：水平 + 垂直都居中 */
const CENTER = { alignment: { horizontal: 'center', vertical: 'center' } };

/**
 * @param {{ date: string, rows: { sku: string, name?: string, platform?: string, category?: string }[] }} input
 * @returns {Buffer}
 */
export function buildWorkReport(input) {
  const date = String(input.date || '');
  const rows = input.rows || [];
  const count = rows.length;
  /** @type {any[][]} */
  const aoa = [];

  rows.forEach((r, i) => {
    aoa.push([
      i === 0 ? date : '',
      i === 0 ? `产品拍摄*${count}` : '',
      String(r.sku || ''),
      String(r.name || ''),
      String(r.platform || ''),
      String(r.category || '产品/视频拍摄'),
      i === 0 ? '待填' : '',
      i === 0 ? '待填' : '',
      i === 0 ? '待填' : '',
      i === 0 ? '100%' : '',
      i === 0 ? '文件夹截图' : '',
    ]);
  });

  // 「图片上传」行：文字写在 SKU 列，类别「其它」；其余留空
  aoa.push(['', '', '图片上传', '', '', '其它', '', '', '', '', '']);
  // 模板末尾还有一行空行
  aoa.push(new Array(COLS).fill(''));

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const lastProductRow = count - 1; // 0 基，最后一条产品
  const uploadRow = count; // 0 基，「图片上传」行

  /** @type {{ s: { r: number, c: number }, e: { r: number, c: number } }[] } */
  const merges = [
    { s: { r: 0, c: 0 }, e: { r: uploadRow, c: 0 } }, // A 日期
    { s: { r: 0, c: 1 }, e: { r: uploadRow, c: 1 } }, // B 今日完成工作
    { s: { r: 0, c: 6 }, e: { r: lastProductRow, c: 6 } }, // G 拍摄时长（只到产品行）
    { s: { r: 0, c: 7 }, e: { r: lastProductRow, c: 7 } }, // H 包装/安装/拆卸（只到产品行）
    { s: { r: 0, c: 8 }, e: { r: uploadRow, c: 8 } }, // I 总工作时长
    { s: { r: 0, c: 9 }, e: { r: uploadRow, c: 9 } }, // J 进度百分比（通栏）
    { s: { r: 0, c: 10 }, e: { r: uploadRow, c: 10 } }, // K 文件夹截图（通栏）
  ];
  ws['!merges'] = merges;

  const styleCell = (/** @type {number} */ r, /** @type {number} */ c) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = /** @type {{ s?: unknown } | undefined} */ (ws[addr]);
    if (cell) cell.s = CENTER;
    else ws[addr] = { t: 's', v: '', s: CENTER };
  };
  // 所有内容（含合并区里的空单元格）统一水平 + 垂直居中
  for (let r = 0; r < aoa.length; r++) {
    for (let c = 0; c < COLS; c++) styleCell(r, c);
  }

  ws['!cols'] = [
    { wch: 12 }, // A 日期
    { wch: 15 }, // B 今日完成工作
    { wch: 30 }, // C SKU
    { wch: 24 }, // D 品名
    { wch: 10 }, // E 平台
    { wch: 16 }, // F 类别
    { wch: 12 }, // G 拍摄时长
    { wch: 18 }, // H 包装/安装/拆卸
    { wch: 18 }, // I 总工作时长
    { wch: 10 }, // J 进度
    { wch: 20 }, // K 文件夹截图
  ];
  ws['!rows'] = Array.from({ length: aoa.length }, () => ({ hpt: 15 }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '工作日报');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
