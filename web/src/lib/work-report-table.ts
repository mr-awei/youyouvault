/**
 * 工作日报「复制表格」用的 HTML / TSV 构造。
 *
 * 列结构必须与后端 server/lib/work-report.js 生成的 xlsx 完全一致（13 列，与人工模板逐列对齐）：
 *   A 日期 | B 今日完成工作 | C 运营（空） | D SKU | E 品名 | F 平台 | G 类别 |
 *   H 拍摄时长 | I 包装/安装/拆卸 | J 总工作时长 | K 进度 | L 文件夹截图 | M 主管/组长/带教（空）
 *
 * C 列「运营」是模板里就有的空列，不能删也不能填内容；删掉会让 SKU 落到 C 列、整张表左移。
 * 抽成纯函数 + 单测，避免前端和 xlsx 各改各的。
 */

export interface WorkReportTableRow {
  sku: string;
  name?: string;
  platform?: string;
  category?: string;
}

/** xlsx 也是 13 列（A..M），两边一起改 */
export const WORK_REPORT_COLUMNS = 13;

const CELL_STYLE = 'text-align:center;vertical-align:middle;';

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param date 拍摄日期（YYYY-MM-DD）
 * @param rows SKU 行（末尾会自动补一行「图片上传」）
 */
export function buildWorkReportTable(date: string, rows: WorkReportTableRow[]) {
  const mainCount = rows.length;
  const totalRows = mainCount + 1; // 末尾还有一行「图片上传」

  const aoa: string[][] = rows.map((r, i) => [
    i === 0 ? date : '',
    i === 0 ? `产品拍摄*${mainCount}` : '',
    '', // C 运营：空列
    r.sku,
    r.name ?? '',
    r.platform ?? '',
    r.category ?? '',
    i === 0 ? '待填' : '',
    i === 0 ? '待填' : '',
    i === 0 ? '待填' : '',
    i === 0 ? '100%' : '',
    i === 0 ? '文件夹截图' : '',
    '', // M 主管/组长/带教：空列
  ]);
  aoa.push(['', '', '', '图片上传', '', '', '其它', '', '', '', '', '', '']);

  const rowsHtml: string[] = [];
  rows.forEach((r, i) => {
    let cells = '';
    if (i === 0) {
      // 日期与「产品拍摄*N」都通到「图片上传」行
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">${esc(date)}</td>`;
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">${esc(`产品拍摄*${mainCount}`)}</td>`;
    }
    cells += `<td style="${CELL_STYLE}"></td>`; // C 运营
    cells +=
      `<td style="${CELL_STYLE}">${esc(r.sku)}</td>` +
      `<td style="${CELL_STYLE}">${esc(r.name)}</td>` +
      `<td style="${CELL_STYLE}">${esc(r.platform)}</td>` +
      `<td style="${CELL_STYLE}">${esc(r.category)}</td>`;
    if (i === 0) {
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">待填</td>`;
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">待填</td>`;
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">待填</td>`;
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">100%</td>`;
      cells += `<td rowspan="${totalRows}" style="${CELL_STYLE}">文件夹截图</td>`;
    }
    cells += `<td style="${CELL_STYLE}"></td>`; // M 主管/组长/带教
    rowsHtml.push(`<tr>${cells}</tr>`);
  });
  // 图片上传行：A/B 与右侧五列已被上面的 rowspan 占住，只补 运营/SKU/品名/平台/类别/主管 六列
  rowsHtml.push(
    `<tr><td style="${CELL_STYLE}"></td><td style="${CELL_STYLE}">图片上传</td><td style="${CELL_STYLE}"></td><td style="${CELL_STYLE}"></td><td style="${CELL_STYLE}">其它</td><td style="${CELL_STYLE}"></td></tr>`
  );

  const html =
    `<html><body><table border="1" cellspacing="0" cellpadding="4" ` +
    `style="border-collapse:collapse;font-family:'Microsoft YaHei',Arial,sans-serif;font-size:12px;` +
    `text-align:center;vertical-align:middle">${rowsHtml.join('')}</table></body></html>`;

  return { aoa, html, totalRows };
}
