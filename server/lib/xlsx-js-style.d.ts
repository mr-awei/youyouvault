/**
 * xlsx-js-style 没有自带类型声明。这里只声明工作日报生成用到的最小面，
 * 避免 server/lib 的 // @ts-check 把导入当成 any 模块报错。
 */
declare module 'xlsx-js-style' {
  export const utils: {
    aoa_to_sheet: (data: unknown[][]) => Record<string, unknown>;
    book_new: () => Record<string, unknown>;
    book_append_sheet: (wb: Record<string, unknown>, ws: Record<string, unknown>, name: string) => void;
    encode_cell: (cell: { r: number; c: number }) => string;
    encode_col: (col: number) => string;
    decode_range: (ref: string) => { s: { r: number; c: number }; e: { r: number; c: number } };
  };
  export function read(data: unknown, opts?: Record<string, unknown>): Record<string, unknown>;
  export function write(wb: Record<string, unknown>, opts?: Record<string, unknown>): Buffer;

  const XLSX: {
    utils: typeof utils;
    read: typeof read;
    write: typeof write;
  };
  export default XLSX;
}
