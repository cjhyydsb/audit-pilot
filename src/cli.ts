import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseChecklistJson, parseChecklistXlsx, filterItems } from './checklist.js';
import type { ChecklistItem } from './checklist.js';
import { collect } from './collector.js';
import type { CmdRunner, CollectResult } from './collector.js';
import { judgeAll } from './judge.js';
import type { JudgeResult } from './judge.js';
import { renderReport, renderScreenshotScript } from './report.js';
import { appendAuditLog, assertCommandSafe } from './guard.js';
import type { GuardResult } from './guard.js';
import { makeRunner } from './ssh.js';
import { startApprovalServer } from './approval-server.js';

const USAGE = `audit-pilot —— 等保/基线核查辅助工具

用法:
  npx tsx src/cli.ts --json <清单.json> --host <主机> --port <端口> --user <用户> --pass <密码> [--out <输出目录>]
  npx tsx src/cli.ts --xlsx <清单.xlsx> --host <主机> --port <端口> --user <用户> --pass <密码> [--out <输出目录>]

参数:
  --json <path>     JSON 格式核查清单（ChecklistItem 数组）
  --xlsx <path>     XLSX 格式核查清单（列序：A=编号 B=核查项 C=命令 D=符合标准 E=不符合标准 F=备注）
  --host <host>     目标机 SSH 地址
  --port <port>     SSH 端口（默认 22）
  --user <user>     SSH 用户名
  --pass <pass>     SSH 密码（与 --key 二选一）
  --key <path>      SSH 私钥文件路径（与 --pass 二选一）
  --timeout <ms>    SSH 连接超时毫秒数（默认 15000）
  --out <dir>       输出目录（默认 out）
  --dry-run         只打印执行计划（命令+guard 预审），不连接服务器、不执行
  --interactive     Web 审批模式：起本地审批页（仅 127.0.0.1），人工在浏览器勾选放行后才执行
  --only <ids>      只执行指定编号（逗号分隔，如 --only H-01,H-03），配合人工放行

产物:
  <out>/report.md            初筛报告（统计摘要 + 逐项结论）
  <out>/screenshot-script.md 截图取证脚本（仅 fail / manual 项，供人工执行并截图）
  <out>/audit-log.jsonl      命令安全审查审计日志（拦截与放行均记录）
  <out>/plan.md              执行计划（--dry-run 时生成）

安全说明:
  每条命令执行前都经过只读白名单 guard 审查，危险命令一律拦截、不执行。`;

interface CliArgs {
  json?: string;
  xlsx?: string;
  host?: string;
  port: number;
  user?: string;
  pass?: string;
  key?: string;
  out: string;
  timeout: number;
  dryRun: boolean;
  interactive: boolean;
  only?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { port: 22, out: 'out', timeout: 15000, dryRun: false, interactive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`参数 ${a} 缺少取值`);
      }
      i++;
      return v;
    };
    switch (a) {
      case '--json':
        args.json = next();
        break;
      case '--xlsx':
        args.xlsx = next();
        break;
      case '--host':
        args.host = next();
        break;
      case '--port':
        args.port = Number(next());
        break;
      case '--user':
        args.user = next();
        break;
      case '--pass':
        args.pass = next();
        break;
      case '--key':
        args.key = next();
        break;
      case '--timeout':
        args.timeout = Number(next());
        break;
      case '--out':
        args.out = next();
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--interactive':
        args.interactive = true;
        break;
      case '--only':
        args.only = next();
        break;
      default:
        throw new Error(`未知参数：${a}`);
    }
  }
  return args;
}

function validateArgs(args: CliArgs): string[] {
  const problems: string[] = [];
  if (!args.json && !args.xlsx) problems.push('必须指定 --json 或 --xlsx 之一');
  if (args.json && args.xlsx) problems.push('--json 与 --xlsx 只能二选一');
  if (args.dryRun && args.interactive) problems.push('--interactive 与 --dry-run 互斥');
  // --dry-run 不连接服务器，无需 SSH 参数（--interactive 放行后才连接，但参数仍需齐全）
  if (!args.dryRun) {
    if (!args.host) problems.push('必须指定 --host');
    if (!args.user) problems.push('必须指定 --user');
    if (!args.pass && !args.key) problems.push('必须指定 --pass 或 --key 之一');
  }
  if (Number.isNaN(args.port) || args.port <= 0) problems.push('--port 必须是正整数');
  if (Number.isNaN(args.timeout) || args.timeout <= 0) problems.push('--timeout 必须是正整数');
  return problems;
}

async function loadChecklist(args: CliArgs): Promise<ChecklistItem[]> {
  if (args.json !== undefined) {
    return parseChecklistJson(fs.readFileSync(args.json, 'utf8'));
  }
  if (args.xlsx !== undefined) {
    return parseChecklistXlsx(args.xlsx);
  }
  throw new Error('必须指定 --json 或 --xlsx 之一');
}

/**
 * 核心流水线（供 CLI 与冒烟验证复用）：
 * collect（guard 审查+执行）→ 审计日志 → judgeAll → 写报告与截图脚本 → 返回统计。
 */
export async function runPipeline(
  items: ChecklistItem[],
  run: CmdRunner,
  outDir: string
): Promise<{
  collects: CollectResult[];
  judges: JudgeResult[];
  summary: { total: number; pass: number; fail: number; manual: number; blocked: number };
  files: string[];
}> {
  fs.mkdirSync(outDir, { recursive: true });

  // 1. 采集（guard 拦截的不会执行）
  const collects = await collect(items, run);

  // 2. 审计日志：拦截与放行执行的都记录
  const auditLogPath = path.join(outDir, 'audit-log.jsonl');
  for (const c of collects) {
    appendAuditLog(auditLogPath, {
      time: new Date().toISOString(),
      command: c.command,
      ok: c.blocked === undefined,
      reason: c.blocked,
    });
  }

  // 3. 判定
  const judges = judgeAll(items, collects);

  // 4. 产物
  const reportPath = path.join(outDir, 'report.md');
  const scriptPath = path.join(outDir, 'screenshot-script.md');
  fs.writeFileSync(reportPath, renderReport(items, collects, judges), 'utf8');
  fs.writeFileSync(scriptPath, renderScreenshotScript(items, collects, judges), 'utf8');

  const summary = {
    total: judges.length,
    pass: judges.filter((j) => j.verdict === 'pass').length,
    fail: judges.filter((j) => j.verdict === 'fail').length,
    manual: judges.filter((j) => j.verdict === 'manual').length,
    blocked: collects.filter((c) => c.blocked !== undefined).length,
  };
  return { collects, judges, summary, files: [reportPath, scriptPath, auditLogPath] };
}

/**
 * win32 下尝试用默认浏览器打开审批页（`cmd /c start "" "<url>"`）；
 * 失败仅打印 URL 不报错；非 win32 平台只打印 URL 由用户手动打开。
 */
function openBrowser(url: string): void {
  if (process.platform !== 'win32') return;
  try {
    exec(`start "" "${url}"`, { shell: process.env.ComSpec ?? 'cmd.exe' }, () => undefined);
  } catch {
    /* 打不开浏览器没关系，URL 已打印 */
  }
}

/**
 * Web 审批模式（--interactive）：
 * 预审 → 起仅监听 127.0.0.1 的审批页 → 人工勾选放行 → 放行项才建立 SSH 并执行 →
 * 结果回填审批页 → 打印统计与产物。拒绝/超时则什么都不执行，退出码 0。
 */
async function runInteractive(args: CliArgs, items: ChecklistItem[]): Promise<void> {
  // 1. 逐项 guard 预审，构建审批页展示与放行约束
  const guardResults = new Map<string, GuardResult>();
  for (const item of items) {
    guardResults.set(item.id, assertCommandSafe(item.command));
  }
  const blockedCount = [...guardResults.values()].filter((g) => !g.ok).length;

  // 2. 起审批 server（仅 127.0.0.1，一次性 token，超时自动拒绝）
  const server = await startApprovalServer({
    items,
    guardResults,
    target: `${args.host}:${args.port}`,
  });

  console.log('==========================================================');
  console.log('  需要人工放行：请在浏览器中打开审批页，勾选并放行核查命令');
  console.log(`  审批页面：${server.url}`);
  console.log(`  共 ${items.length} 项（guard 预审拦截 ${blockedCount} 项不可放行），5 分钟内未操作将自动拒绝`);
  console.log('==========================================================');
  openBrowser(server.url);

  // 3. 等待浏览器决定（approve / reject / timeout）
  const decision = await server.waitDecision();
  if (decision.type !== 'approve' || decision.ids.length === 0) {
    console.log(decision.type === 'timeout' ? '超时未放行，未执行任何命令' : '已拒绝，未执行任何命令');
    server.close();
    return; // 退出码 0：人工拒绝不算失败
  }

  // 4. 只执行放行的项（approve 的 ids 已限定在预审放行集合内，这里再过滤一次）
  let chosen: ChecklistItem[];
  try {
    chosen = filterItems(items, decision.ids.join(','));
  } catch (e) {
    console.error(`放行编号异常，未执行任何命令：${(e as Error).message}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  // 5. 放行后才建立 SSH 连接
  let run: CmdRunner & { close(): void };
  try {
    run = await makeRunner({
      host: args.host as string,
      port: args.port,
      username: args.user as string,
      password: args.pass,
      privateKeyPath: args.key,
      timeoutMs: args.timeout,
    });
  } catch (e) {
    console.error((e as Error).message);
    server.close();
    process.exitCode = 1;
    return;
  }

  try {
    const { collects, judges, summary, files } = await runPipeline(chosen, run, args.out);
    server.setResults({ summary, judges, collects });
    console.log('=== 核查完成 ===');
    console.log(
      `核查项总数：${summary.total}  符合（pass）：${summary.pass}  不符合（fail）：${summary.fail}  待人工确认（manual）：${summary.manual}  被安全审查拦截：${summary.blocked}`
    );
    for (const f of files) {
      console.log(`产物：${f}`);
    }
    // 等一个轮询周期，让浏览器审批页取回最终结果再关 server
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } finally {
    run.close();
    server.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.log(USAGE);
    return; // 无参数：打印用法，退出码 0
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`参数解析失败：${(e as Error).message}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const problems = validateArgs(args);
  if (problems.length > 0) {
    console.error(`参数错误：\n  - ${problems.join('\n  - ')}\n`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // 读取清单
  let items: ChecklistItem[];
  try {
    items = await loadChecklist(args);
  } catch (e) {
    console.error(`读取核查清单失败：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (items.length === 0) {
    console.error('核查清单为空，无可执行项');
    process.exitCode = 1;
    return;
  }

  // 人工放行过滤（--only 指定不存在的编号会报错退出）
  try {
    items = filterItems(items, args.only);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  if (items.length === 0) {
    console.error('--only 过滤后清单为空');
    process.exitCode = 1;
    return;
  }

  // --dry-run：只打印执行计划，不连接服务器
  if (args.dryRun) {
    const { renderPlan } = await import('./report.js');
    const plan = renderPlan(items);
    fs.mkdirSync(args.out, { recursive: true });
    const planPath = path.join(args.out, 'plan.md');
    fs.writeFileSync(planPath, plan, 'utf8');
    console.log(plan);
    console.log(`\n产物：${planPath}`);
    return;
  }

  // --interactive：Web 审批模式（人工在浏览器逐条放行后才执行）
  if (args.interactive) {
    await runInteractive(args, items);
    return;
  }

  // 建立 SSH 连接
  let run: CmdRunner & { close(): void };
  try {
    run = await makeRunner({
      host: args.host as string,
      port: args.port,
      username: args.user as string,
      password: args.pass,
      privateKeyPath: args.key,
      timeoutMs: args.timeout,
    });
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return;
  }

  try {
    const { summary, files } = await runPipeline(items, run, args.out);
    console.log('=== 核查完成 ===');
    console.log(
      `核查项总数：${summary.total}  符合（pass）：${summary.pass}  不符合（fail）：${summary.fail}  待人工确认（manual）：${summary.manual}  被安全审查拦截：${summary.blocked}`
    );
    for (const f of files) {
      console.log(`产物：${f}`);
    }
  } finally {
    run.close();
  }
}

// 仅当作为主模块直接运行（npx tsx src/cli.ts / node dist/cli.js）时执行 main，
// 被其他模块 import（如复用 runPipeline）时不产生副作用。
// 注意用 realpathSync 归一化两侧：目录联接/junction 下 argv[1] 与 import.meta.url
// 可能分别是联接路径与真实路径（如 C:\Users\... ↔ D:\...），字符串直比会误判。
function isMainModule(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  void main();
}
