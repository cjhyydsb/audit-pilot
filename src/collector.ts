import stripAnsi from 'strip-ansi';
import { assertCommandSafe } from './guard.js';
import type { ChecklistItem } from './checklist.js';

/** 单条命令采集结果 */
export interface CollectResult {
  id: string;
  command: string;
  ok: boolean; // 命令是否成功执行（SSH 层面）
  exitCode: number | null;
  output: string; // 合并 stdout+stderr，已 strip-ansi
  error?: string;
  blocked?: string; // guard 拦截原因
}

export type CmdRunner = (cmd: string) => Promise<{ exitCode: number; output: string }>;

/**
 * 逐条采集核查项输出。
 * 每条先经 assertCommandSafe 审查：被拦截 → ok:false、blocked 填原因、不调用 run；
 * 放行才执行 run；run 抛错 → ok:false、error 填原因，且不影响后续项。
 */
export async function collect(items: ChecklistItem[], run: CmdRunner): Promise<CollectResult[]> {
  const results: CollectResult[] = [];
  for (const item of items) {
    // 安全审查（放行的才执行）
    const guard = assertCommandSafe(item.command);
    if (!guard.ok) {
      results.push({
        id: item.id,
        command: item.command,
        ok: false,
        exitCode: null,
        output: '',
        blocked: `${guard.reason}（段：${guard.blockedSegment}）`,
      });
      continue;
    }

    // 执行采集
    try {
      const { exitCode, output } = await run(item.command);
      results.push({
        id: item.id,
        command: item.command,
        ok: true,
        exitCode,
        output: stripAnsi(output),
      });
    } catch (e) {
      results.push({
        id: item.id,
        command: item.command,
        ok: false,
        exitCode: null,
        output: '',
        error: (e as Error).message,
      });
    }
  }
  return results;
}
