/**
 * xlsx-js-style（SheetJS 的样式分支）没有自带类型声明。
 * 这里声明 OfficeViewer 用到的 read / write 与 utils 子集，避免 strict 模式报未声明模块。
 */
declare module 'xlsx-js-style' {
  interface CellRef {
    r: number;
    c: number;
  }
  interface Range {
    s: CellRef;
    e: CellRef;
  }
  interface Sheet {
    [addr: string]: unknown;
    '!ref'?: string;
    '!merges'?: { s: CellRef; e: CellRef }[];
    '!cols'?: { wpx?: number; wch?: number }[];
  }
  interface Workbook {
    SheetNames: string[];
    Sheets: Record<string, Sheet>;
    [key: string]: unknown;
  }
  export const utils: {
    aoa_to_sheet: (data: unknown[][]) => Sheet;
    book_new: () => Workbook;
    book_append_sheet: (wb: Workbook, ws: Sheet, name: string) => void;
    encode_cell: (cell: CellRef) => string;
    encode_col: (col: number) => string;
    decode_range: (ref: string) => Range;
  };
  export function read(data: ArrayBuffer, opts?: Record<string, unknown>): Workbook;
  export function write(wb: Workbook, opts?: Record<string, unknown>): ArrayBuffer | Uint8Array;

  const XLSX: {
    utils: typeof utils;
    read: typeof read;
    write: typeof write;
  };
  export default XLSX;
}
