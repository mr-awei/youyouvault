// @ts-check
/**
 * 日期文件夹命名学习。
 *
 * 现场每个摄影师的命名习惯不同：有人用 2026-11-23，有人用 20261123，
 * 也有人用 2026_11_23。用户已经整理好的目录里，同级日期文件夹就是最可靠的样例。
 * 这里只做纯字符串判断，不读盘，方便单测；读目录在 routes/barcode.js。
 */

/** 支持的日期文件夹格式；顺序即同票数时的优先级 */
const PATTERNS = [
  { key: 'ymd', label: 'YYYYMMDD', re: /^(\d{4})(\d{2})(\d{2})$/, format: (y, m, d) => `${y}${m}${d}` },
  {
    key: 'ymd-dash',
    label: 'YYYY-MM-DD',
    re: /^(\d{4})-(\d{2})-(\d{2})$/,
    format: (y, m, d) => `${y}-${m}-${d}`,
  },
  {
    key: 'ymd-underscore',
    label: 'YYYY_MM_DD',
    re: /^(\d{4})_(\d{2})_(\d{2})$/,
    format: (y, m, d) => `${y}_${m}_${d}`,
  },
  {
    key: 'ymd-dot',
    label: 'YYYY.MM.DD',
    re: /^(\d{4})\.(\d{2})\.(\d{2})$/,
    format: (y, m, d) => `${y}.${m}.${d}`,
  },
  {
    key: 'ymd-cn',
    label: 'YYYY年MM月DD日',
    re: /^(\d{4})年(\d{2})月(\d{2})日$/,
    format: (y, m, d) => `${y}年${m}月${d}日`,
  },
];

/** 合法日期（只校验年月日范围，容忍 2 月 30 日这种脏数据，避免漏掉样例） */
function plausible(y, m, d) {
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/**
 * 从同级目录名里学习日期文件夹格式。
 * @param {string[]} names
 * @param {{ maxSamples?: number }} [opts]
 * @returns {{ key: string, label: string, count: number, samples: string[] } | null}
 */
export function detectDateNaming(names, { maxSamples = 6 } = {}) {
  /** @type {Map<string, { count: number, samples: string[] }>} */
  const hits = new Map();
  for (const raw of names || []) {
    const name = String(raw || '').trim();
    if (!name) continue;
    for (const p of PATTERNS) {
      const m = name.match(p.re);
      if (!m) continue;
      if (!plausible(Number(m[1]), Number(m[2]), Number(m[3]))) continue;
      const cur = hits.get(p.key) || { count: 0, samples: [] };
      cur.count += 1;
      if (cur.samples.length < maxSamples && !cur.samples.includes(name)) cur.samples.push(name);
      hits.set(p.key, cur);
      break; // 一个名字只算一种格式
    }
  }
  let best = null;
  for (const p of PATTERNS) {
    const hit = hits.get(p.key);
    if (!hit) continue;
    if (!best || hit.count > best.count) {
      best = { key: p.key, label: p.label, count: hit.count, samples: hit.samples };
    }
  }
  return best;
}

/** 按学习到的格式把 YYYY-MM-DD 转成日期文件夹名；格式未知时原样返回 */
export function formatDateFolder(dateISO, key) {
  const raw = String(dateISO || '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  const p = PATTERNS.find((x) => x.key === key);
  return p ? p.format(m[1], m[2], m[3]) : raw;
}

/**
 * 给一个输出根目录的现有子目录名，返回建议的日期文件夹名。
 * 没学到格式时返回标准 YYYY-MM-DD，调用方仍可让用户手改。
 * @param {string[]} names
 * @param {string} dateISO
 */
export function suggestDateFolder(names, dateISO) {
  const learned = detectDateNaming(names);
  if (!learned) return { name: dateISO, learned: false, key: '', label: '', count: 0, samples: [] };
  return {
    name: formatDateFolder(dateISO, learned.key),
    learned: true,
    key: learned.key,
    label: learned.label,
    count: learned.count,
    samples: learned.samples,
  };
}
