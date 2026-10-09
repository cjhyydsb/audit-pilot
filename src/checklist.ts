import * as XLSX from 'xlsx';

/** 一条核查项 = 一条只读命令 + 符合/不符合判定规则 */
export interface ChecklistItem {
  id: string; // 核查项编号
  clause: string; // 条款/核查项描述
  command: string; // 核查命令（只读）
  passPattern?: string; // 正则源字符串，输出命中 → 符合
  failPattern?: string; // 正则源字符串，输出命中 → 不符合
  note?: string; // 备注
}

/** 单元格值 → 字符串；空串归一化为 undefined（可选字段） */
function cellToOptionalString(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

/** 单元格值 → 必填字符串（空归一化为空串，由上层校验） */
function cellToString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * 解析 JSON 格式核查清单（ChecklistItem 数组）。
 * 非法 JSON 或非数组结构时抛出含“清单”的错误。
 */
export function parseChecklistJson(text: string): ChecklistItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`核查清单 JSON 解析失败：${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('核查清单格式错误：顶层必须是 JSON 数组');
  }
  return parsed.map((row, i) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`核查清单第 ${i + 1} 项不是对象`);
    }
    const o = row as Record<string, unknown>;
    const item: ChecklistItem = {
      id: cellToString(o.id),
      clause: cellToString(o.clause),
      command: cellToString(o.command),
    };
    const pass = cellToOptionalString(o.passPattern);
    const fail = cellToOptionalString(o.failPattern);
    const note = cellToOptionalString(o.note);
    if (pass !== undefined) item.passPattern = pass;
    if (fail !== undefined) item.failPattern = fail;
    if (note !== undefined) item.note = note;
    if (!item.id || !item.command) {
      throw new Error(`核查清单第 ${i + 1} 项缺少编号(id)或命令(command)`);
    }
    return item;
  });
}

/**
 * 按 --only 编号列表过滤清单（人工放行机制）。
 * undefined/空串返回全量；逗号分隔、容忍空白与空段；
 * 含清单中不存在的编号时抛错（防止放行了不存在的项却静默通过）。
 */
export function filterItems(items: ChecklistItem[], only?: string): ChecklistItem[] {
  if (only === undefined || only.trim() === '') return items;
  const wanted = new Set(
    only
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  const known = new Set(items.map((i) => i.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(`清单中不存在以下编号：${unknown.join('、')}`);
  }
  return items.filter((i) => wanted.has(i.id));
}

/**
 * 解析 XLSX 格式核查清单。
 * 列顺序：A=编号 B=核查项 C=命令 D=符合标准 E=不符合标准 F=备注；
 * 取首个工作表；首行 A 列值为“编号”则视为表头跳过。
 */
export async function parseChecklistXlsx(path: string): Promise<ChecklistItem[]> {
  const wb = XLSX.readFile(path);
  const sheetName = wb.SheetNames[0];
  if (!sheetName) {
    throw new Error('核查清单 XLSX 解析失败：文件中没有工作表');
  }
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });

  let start = 0;
  const first = rows[0];
  if (Array.isArray(first) && cellToString(first[0]) === '编号') {
    start = 1; // 跳过表头行
  }

  const items: ChecklistItem[] = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const item: ChecklistItem = {
      id: cellToString(row[0]),
      clause: cellToString(row[1]),
      command: cellToString(row[2]),
    };
    if (!item.id && !item.command) continue; // 跳过整行空白
    const pass = cellToOptionalString(row[3]);
    const fail = cellToOptionalString(row[4]);
    const note = cellToOptionalString(row[5]);
    if (pass !== undefined) item.passPattern = pass;
    if (fail !== undefined) item.failPattern = fail;
    if (note !== undefined) item.note = note;
    items.push(item);
  }
  return items;
}
