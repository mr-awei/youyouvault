#!/usr/bin/env node
/**
 * 打一个可双击运行的「图库授权管理」Windows 便携版 exe。
 *
 *   npm run license:admin:dist
 *
 * 产物：release-build/license-admin/TuKu-LicenseAdmin-<version>.exe
 *
 * 做法：用 esbuild 把 Electron 主进程 + 本地管理服务 + 授权核心打成一个 ESM 文件，
 * 再在一个**仓库外的临时目录**里让 electron-builder 打包 —— 这样不会把主项目的
 * node_modules（sharp / onnxruntime / react…）误装进管理工具。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'license-admin');
const OUT_DIR = process.env.TUKU_LICENSE_ADMIN_OUT
  ? path.resolve(ROOT, process.env.TUKU_LICENSE_ADMIN_OUT)
  : path.join(ROOT, 'release-build', 'license-admin');
const BUILD_DIR = path.join(os.tmpdir(), 'tuku-license-admin-build');
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')
).version;

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

console.log('[admin-build] 打包主进程…');
await build({
  entryPoints: [path.join(TOOL, 'main.mjs')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(BUILD_DIR, 'main.mjs'),
  external: ['electron'],
  legalComments: 'none',
  sourcemap: false,
});

fs.cpSync(path.join(TOOL, 'public'), path.join(BUILD_DIR, 'public'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'server', 'license-public.pem'), path.join(BUILD_DIR, 'license-public.pem'));
if (fs.existsSync(path.join(ROOT, 'build', 'icon.ico'))) {
  fs.copyFileSync(path.join(ROOT, 'build', 'icon.ico'), path.join(BUILD_DIR, 'icon.ico'));
}

fs.writeFileSync(
  path.join(BUILD_DIR, 'package.json'),
  `${JSON.stringify(
    {
      name: 'tuku-license-admin',
      productName: '图库授权管理',
      version: rootPkg.version,
      private: true,
      type: 'module',
      main: 'main.mjs',
      description: '图库授权签发、记录与停用管理工具（本机）',
      devDependencies: { electron: electronVersion },
    },
    null,
    2
  )}\n`,
  'utf8'
);

// 配置写在临时 app 目录里：directories.app = "."，避免 electron-builder 把仓库根当成 workspace 去收集依赖
const config = {
  appId: 'com.tuku.licenseadmin',
  productName: 'TuKu-LicenseAdmin',
  directories: { app: '.', output: OUT_DIR },
  files: ['main.mjs', 'public/**/*', 'license-public.pem', 'icon.ico', 'package.json'],
  asar: true,
  compression: 'maximum',
  npmRebuild: false,
  buildDependenciesFromSource: false,
  win: {
    target: [{ target: 'portable', arch: ['x64'] }],
    icon: 'icon.ico',
    artifactName: 'TuKu-LicenseAdmin-${version}.exe',
  },
  portable: { artifactName: 'TuKu-LicenseAdmin-${version}.exe' },
};
const configFile = path.join(BUILD_DIR, 'electron-builder.json');
fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(builderCli)) {
  console.error('[admin-build] 找不到 electron-builder：先 npm install');
  process.exit(1);
}

console.log('[admin-build] electron-builder（portable）…');
await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [builderCli, '--config', configFile, '--publish', 'never', `-c.electronVersion=${electronVersion}`],
    { cwd: BUILD_DIR, stdio: 'inherit', env: process.env }
  );
  child.on('exit', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`打包失败，退出码 ${code}`))));
  child.on('error', reject);
});

if (process.env.TUKU_KEEP_ADMIN_BUILD !== '1') {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

const exe = path.join(OUT_DIR, `TuKu-LicenseAdmin-${rootPkg.version}.exe`);
console.log('');
console.log(`[admin-build] 完成：${exe}`);
console.log('[admin-build] 双击这个 exe 即可打开授权管理窗口。');
