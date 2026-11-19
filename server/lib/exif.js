// @ts-check
// 极简 EXIF 解析：只取检查器里真正有用的那十几个标签。
// sharp 能给出 exif 原始 TIFF 块，但没有解析；为了不引入 exif-parser 这类老依赖，这里手写
// TIFF IFD 遍历（约 100 行），失败一律返回空对象——读不出 EXIF 不是错误。
const TAGS = new Map([
  [0x010f, 'make'],
  [0x0110, 'model'],
  [0x0112, 'orientation'],
  [0x0131, 'software'],
  [0x0132, 'modified'],
  [0x829a, 'exposureTime'],
  [0x829d, 'fNumber'],
  [0x8827, 'iso'],
  [0x9003, 'takenAt'],
  [0x920a, 'focalLength'],
  [0x9290, 'subsec'],
  [0xa434, 'lens'],
  [0x9202, 'aperture'],
  [0x9204, 'exposureBias'],
  [0x013b, 'artist'],
  [0x8298, 'copyright'],
]);

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

function readAscii(buf, off, count) {
  const s = buf.toString('latin1', off, off + count);
  return s.replace(/\0.*$/, '').trim();
}

function readValue(buf, le, type, count, valueOff) {
  const size = (TYPE_SIZE[type] || 1) * count;
  // 值只有 ≤4 字节时直接内联在条目里，否则那 4 字节是数据偏移
  const dataOff = size <= 4 ? valueOff : le ? buf.readUInt32LE(valueOff) : buf.readUInt32BE(valueOff);
  if (dataOff < 0 || dataOff >= buf.length) return '';
  if (type === 2) return readAscii(buf, dataOff, Math.min(count, buf.length - dataOff));
  if (type === 3) return le ? buf.readUInt16LE(dataOff) : buf.readUInt16BE(dataOff);
  if (type === 4) return le ? buf.readUInt32LE(dataOff) : buf.readUInt32BE(dataOff);
  if (type === 5 && count >= 1) {
    const n = le ? buf.readUInt32LE(dataOff) : buf.readUInt32BE(dataOff);
    const d = le ? buf.readUInt32LE(dataOff + 4) : buf.readUInt32BE(dataOff + 4);
    return d ? n / d : 0;
  }
  return 0;
}

function walkIfd(buf, le, offset, out, seen = new Set()) {
  if (!offset || offset + 2 > buf.length || seen.has(offset)) return;
  seen.add(offset);
  const count = le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset);
  const start = offset + 2;
  for (let i = 0; i < count; i++) {
    const e = start + i * 12;
    if (e + 12 > buf.length) break;
    const tag = le ? buf.readUInt16LE(e) : buf.readUInt16BE(e);
    const type = le ? buf.readUInt16LE(e + 2) : buf.readUInt16BE(e + 2);
    const n = le ? buf.readUInt32LE(e + 4) : buf.readUInt32BE(e + 4);
    const valOff = e + 8;
    if (tag === 0x8769) {
      const sub = type === 4 && n === 1 ? (le ? buf.readUInt32LE(valOff) : buf.readUInt32BE(valOff)) : 0;
      walkIfd(buf, le, sub, out, seen);
      continue;
    }
    const key = TAGS.get(tag);
    if (!key) continue;
    try {
      const v = readValue(buf, le, type, n, valOff);
      if (v !== '' && v !== 0) out[key] = v;
    } catch {
      /* 单条坏了不影响其它 */
    }
  }
}

/** @param {Buffer} raw sharp metadata() 里的 exif 原始块（带 "Exif\0\0" 前缀） */
export function parseExif(raw) {
  if (!Buffer.isBuffer(raw)) return {};
  // sharp 给的是整个 APP1 载荷（"Exif\0\0" + TIFF 头），TIFF 头从偏移 6 开始；
  // 也有调用方直接传纯 TIFF 块，两种情况都吃下来，否则真实照片会一条都读不出。
  let exif = raw;
  if (raw.length >= 6 && raw.toString('latin1', 0, 4) === 'Exif' && raw.readUInt16BE(4) === 0) {
    exif = raw.subarray(6);
  }
  if (exif.length < 12) return {};
  const head = exif.toString('latin1', 0, 2);
  const le = head === 'II';
  if (!le && head !== 'MM') return {};
  const magic = le ? exif.readUInt16LE(2) : exif.readUInt16BE(2);
  if (magic !== 42) return {};
  const ifd0 = le ? exif.readUInt32LE(4) : exif.readUInt32BE(4);
  const out = {};
  try {
    walkIfd(exif, le, ifd0, out);
  } catch {
    return {};
  }
  const round = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)) : '');
  const res = {};
  const make = String(out.make || '').trim();
  const model = String(out.model || '').trim();
  if (make) res.make = make;
  if (model) res.model = model;
  if (make || model) {
    // 很多机型 model 里已经带品牌（"Canon EOS R5"），别再拼成 "Canon Canon EOS R5"
    const dup = model && make && model.toLowerCase().startsWith(make.toLowerCase());
    res.camera = dup ? model : [make, model].filter(Boolean).join(' ');
  }
  if (out.lens) res.lens = out.lens;
  if (out.takenAt || out.modified) res.takenAt = out.takenAt || out.modified;
  // EXIF 时间是 '2026:11:02 14:33:05'，海报文案里要 '2026-11-02 14:33'
  if (res.takenAt) {
    const m = String(res.takenAt).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
    if (m) res.takenAtText = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
    else if (/^\d{4}-\d{2}-\d{2}/.test(String(res.takenAt))) res.takenAtText = String(res.takenAt).slice(0, 16);
  }
  if (out.exposureTime) res.exposure = out.exposureTime >= 1 ? `${round(out.exposureTime, 1)}s` : `1/${Math.round(1 / out.exposureTime)}s`;
  if (out.fNumber) res.aperture = `f/${round(out.fNumber, 1)}`;
  if (out.iso) res.iso = Math.round(out.iso);
  if (out.focalLength) res.focalLength = `${round(out.focalLength, 1)}mm`;
  if (out.software) res.software = out.software;
  if (out.orientation) res.orientation = out.orientation;
  return res;
}
