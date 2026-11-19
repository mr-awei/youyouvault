import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { trashFileScript } from './lib/applescript.js';

const execFileAsync = promisify(execFile);

export const platform = os.platform();

/** 桌面端（Electron）下可用原生能力 */
let shellPromise = null;
async function electronShell() {
  // 纯 Node 环境（网页模式 / 冒烟 / CI）没有 electron 运行时，import 会去下载 100MB+ 的二进制
  if (!process.versions.electron) return null;
  if (!shellPromise) {
    shellPromise = import('electron')
      .then((m) => (m && m.shell && typeof m.shell.trashItem === 'function' ? m.shell : null))
      .catch(() => null);
  }
  return shellPromise;
}

/** 执行一段 PowerShell 脚本（写入 UTF-8 BOM 临时文件，避免中文路径编码问题） */
async function runPowerShell(body) {
  const tmp = path.join(os.tmpdir(), `tuku_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  fs.writeFileSync(tmp, '\uFEFF' + body, 'utf8');
  try {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      tmp,
    ], { windowsHide: true });
  } finally {
    // 清理临时脚本失败（被 PowerShell/杀软短暂占用会抛 EBUSY）不能覆盖真正的错误
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件留着就留着，系统会清 */
    }
  }
}

/** 把文件移到系统回收站（可恢复） */
export async function moveToTrash(p) {
  if (!p) throw new Error('路径为空');

  const shell = await electronShell();
  if (shell) {
    await shell.trashItem(p);
    return true;
  }

  if (platform === 'win32') {
    const escaped = p.replace(/'/g, "''");
    await runPowerShell(
      'Add-Type -AssemblyName Microsoft.VisualBasic\n' +
        `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${escaped}', ` +
        "'OnlyErrorDialogs', 'SendToRecycleBin')\n"
    );
    return true;
  }
  if (platform === 'darwin') {
    // 路径里可能有引号/反斜杠：统一走 applescript.js 的转义，别直接拼字符串
    await execFileAsync('osascript', ['-e', trashFileScript(p)]);
    return true;
  }
  await execFileAsync('gio', ['trash', p]);
  return true;
}

export function revealFile(p) {
  if (!p) return;
  if (platform === 'win32') execFile('explorer.exe', ['/select,', p], () => {});
  else if (platform === 'darwin') execFile('open', ['-R', p], () => {});
  else execFile('xdg-open', [path.dirname(p)], () => {});
}

export function openFolder(p) {
  if (!p) return;
  if (platform === 'win32') execFile('explorer.exe', [p], () => {});
  else if (platform === 'darwin') execFile('open', [p], () => {});
  else execFile('xdg-open', [p], () => {});
}
