// @ts-check
import os from 'node:os';
import sharp from 'sharp';

/**
 * 全局性能护城河：实时看这台机器还有多少余力，动态决定「图像处理能用几路并发」。
 *
 * 背景：sharp/libvips 默认按核数开线程池。24 核机器上，缩略图后台队列 × 2、
 * 预览队列 × 2、非破坏渲染再乘几路，几十条 libvips 线程同时跑，CPU 直接被打满，
 * 事件循环被拖住 —— 表现就是「软件在跑，但点哪儿都卡」。反过来，4 核老机器上
 * 固定 2 路又太保守，白白慢一截。
 *
 * 这里按 1.5s 采样一次「进程 CPU 占整机百分比 + 系统空闲内存」，给出 1~maxBudget
 * 的预算：
 *   - CPU > 72% 或空闲内存 < 18% → 立刻降一档（保命优先，先降再谈速度）
 *   - CPU < 45% 且空闲内存 > 32% → 升一档（慢慢加，避免在临界点来回抖）
 * 预算同时写进 sharp.concurrency()，libvips 线程池跟着变。
 *
 * 注意：libvips 没有 GPU 后端，图像解码/缩放只能用 CPU；显卡帮上忙的是浏览器侧的
 * 解码与合成（Electron 默认已开硬件加速）。所以这里不做「GPU 加速」的假动作，
 * 只把 CPU 并行度压到「快但不卡」的区间。
 */

const SAMPLE_MS = 1500;
/** 预算上限：留至少 1 核给系统、Electron UI 与事件循环，最多 6 路 */
const MAX_BUDGET = 6;

/** @type {NodeJS.Timeout | null} */
let timer = null;
let lastCpu = process.cpuUsage();
let lastAt = Date.now();

/** @type {{cpuPct:number, sysPct:number, memFreePct:number, cores:number, budget:number, max:number, level:'cool'|'warm'|'hot', at:string}} */
let state = {
  cpuPct: 0,
  sysPct: 0,
  memFreePct: 100,
  cores: 1,
  budget: 2,
  max: 2,
  level: 'cool',
  at: new Date(0).toISOString(),
};

/** 上一次采样的系统级 CPU 时间片，用来算整机占用率（os.cpus 只有累计值） */
let lastSysTimes = os.cpus().map((c) => ({ ...c.times }));

/**
 * 整机 CPU 占用（0~100）。
 * 只看进程自身不够：24 核机器上本进程吃满 6 线程也只有 25%，但系统可能已经被
 * 别的程序拖住了。两个数一起看，才知道「该不该继续加并发」。
 */
function systemCpuPct() {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (let i = 0; i < cpus.length; i++) {
    const now = cpus[i].times;
    const prev = lastSysTimes[i];
    if (!prev) continue;
    const dIdle = now.idle - prev.idle;
    const dTotal =
      now.user - prev.user + (now.nice - prev.nice) + (now.sys - prev.sys) + dIdle + (now.irq - prev.irq);
    if (dTotal > 0) {
      idle += dIdle;
      total += dTotal;
    }
  }
  lastSysTimes = cpus.map((c) => ({ ...c.times }));
  return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
}

/** @type {Set<(s: typeof state) => void>} */
const listeners = new Set();

function coreCount() {
  const n = os.cpus()?.length || 1;
  return Math.max(1, n);
}

/** 这台机器最多允许几路图像并发：核多也给系统留一核，避免整机失去响应 */
function maxBudget() {
  return Math.max(2, Math.min(MAX_BUDGET, coreCount() - 1));
}

function applySharpBudget(n) {
  try {
    sharp.concurrency(n);
  } catch {
    /* 某些平台不支持动态设置：忽略，队列自身的并发上限仍然生效 */
  }
}

function sample() {
  const now = Date.now();
  const used = process.cpuUsage(lastCpu);
  lastCpu = process.cpuUsage();
  const elapsedUs = Math.max(1, (now - lastAt) * 1000);
  lastAt = now;

  // 换算成「占整机」的百分比：单核吃满在 8 核机器上只有 12.5%
  const pct = Math.min(100, Math.max(0, ((used.user + used.system) / elapsedUs / coreCount()) * 100));
  const sysPct = systemCpuPct();
  const memFreePct = os.totalmem() > 0 ? (os.freemem() / os.totalmem()) * 100 : 100;
  const max = maxBudget();

  let budget = state.budget || max;
  // 降档看「整机」也看「自己」：整机热说明别再加，自己热说明该收了
  if (sysPct > 72 || pct > 70 || memFreePct < 18) budget = Math.max(1, budget - 1);
  else if (sysPct < 50 && pct < 45 && memFreePct > 32) budget = Math.min(max, budget + 1);

  const level = budget <= 1 ? 'hot' : budget < max ? 'warm' : 'cool';
  const changed = budget !== state.budget;
  state = {
    cpuPct: Math.round(pct),
    sysPct: Math.round(sysPct),
    memFreePct: Math.round(memFreePct),
    cores: coreCount(),
    budget,
    max,
    level,
    at: new Date(now).toISOString(),
  };
  if (changed) {
    applySharpBudget(budget);
    for (const fn of listeners) {
      try {
        fn(state);
      } catch {
        /* 监听方出错不能影响采样 */
      }
    }
  }
  return state;
}

/** 启动采样（重复调用无副作用）；由服务端启动流程调用一次 */
export function startPerfGuard() {
  if (timer) return state;
  state = { ...state, budget: maxBudget(), max: maxBudget(), cores: coreCount() };
  applySharpBudget(state.budget);
  lastCpu = process.cpuUsage();
  lastAt = Date.now();
  lastSysTimes = os.cpus().map((c) => ({ ...c.times }));
  timer = setInterval(sample, SAMPLE_MS);
  timer.unref?.();
  return state;
}

export function stopPerfGuard() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 给 /api/perf、诊断页用 */
export function perfSnapshot() {
  return { ...state };
}

/** 当前图像并发总预算 */
export function perfBudget() {
  return Math.max(1, Number(state.budget) || 1);
}

/**
 * 把总预算分给三条链路：
 * - preview：用户正在看的大图，优先给一半（最少 1 路）
 * - thumb：列表卡片补图，拿剩下的
 * - derived：非破坏编辑渲染，按总预算算（它最贵，单张可能几百毫秒）
 */
export function imageBudget() {
  const total = perfBudget();
  const preview = Math.max(1, Math.floor(total / 2));
  // derived（非破坏渲染）的请求本身就来自预览/缩略图队列，两边会叠加，
  // 所以它单独只给一半，避免「队列 3 路 + 渲染 3 路」把预算翻倍用掉。
  return {
    preview,
    thumb: Math.max(1, total - preview),
    derived: Math.max(1, Math.ceil(total / 2)),
    total,
  };
}

export function onPerfChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
