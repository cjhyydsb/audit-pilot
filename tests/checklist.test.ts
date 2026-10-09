import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseChecklistJson, parseChecklistXlsx, filterItems } from '../src/checklist.js';
import type { ChecklistItem } from '../src/checklist.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('parseChecklistJson', () => {
  it('1. 合法 JSON 数组 → 字段正确', () => {
    const json = JSON.stringify([
      {
        id: 'S01',
        clause: 'SSH空口令登录',
        command: "grep -E '^\\s*PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config",
        failPattern: 'PermitEmptyPasswords\\s+yes',
        note: '等保要求',
      },
      { id: 'S02', clause: '密码最长使用期', command: "grep -E '^PASS_MAX_DAYS' /etc/login.defs", passPattern: 'PASS_MAX_DAYS\\s+90$' },
    ]);
    const items = parseChecklistJson(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      id: 'S01',
      clause: 'SSH空口令登录',
      command: "grep -E '^\\s*PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config",
      failPattern: 'PermitEmptyPasswords\\s+yes',
      note: '等保要求',
    });
    expect(items[1].id).toBe('S02');
    expect(items[1].passPattern).toBe('PASS_MAX_DAYS\\s+90$');
    expect(items[1].failPattern).toBeUndefined();
    expect(items[1].note).toBeUndefined();
  });

  it('2. 非法 JSON → 抛错且错误信息含“清单”', () => {
    expect(() => parseChecklistJson('{not valid json]')).toThrowError(/清单/);
  });

  it('2b. JSON 非数组 → 抛错含“清单”', () => {
    expect(() => parseChecklistJson('{"a":1}')).toThrowError(/清单/);
  });
});

describe('parseChecklistXlsx', () => {
  function writeTempXlsx(rows: unknown[][]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-pilot-xlsx-'));
    tmpDirs.push(dir);
    const filePath = path.join(dir, 'checklist.xlsx');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    XLSX.writeFile(wb, filePath);
    return filePath;
  }

  const headerRow = ['编号', '核查项', '命令', '符合标准', '不符合标准', '备注'];
  const dataRows = [
    ['S01', '禁止SSH空口令登录', "grep -E '^PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config", '', 'PermitEmptyPasswords\\s+yes', '关键项'],
    ['S02', '密码最长使用期≤90天', "grep -E '^PASS_MAX_DAYS' /etc/login.defs", 'PASS_MAX_DAYS\\s+([1-9]|[1-8][0-9]|90)$', '', ''],
  ];

  it('3. 表头+2数据行 → 解析出 2 项且字段正确', async () => {
    const filePath = writeTempXlsx([headerRow, ...dataRows]);
    const items = await parseChecklistXlsx(filePath);
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('S01');
    expect(items[0].clause).toBe('禁止SSH空口令登录');
    expect(items[0].command).toBe("grep -E '^PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config");
    expect(items[0].failPattern).toBe('PermitEmptyPasswords\\s+yes');
    expect(items[0].passPattern).toBeUndefined();
    expect(items[0].note).toBe('关键项');
    expect(items[1].id).toBe('S02');
    expect(items[1].passPattern).toBe('PASS_MAX_DAYS\\s+([1-9]|[1-8][0-9]|90)$');
    expect(items[1].failPattern).toBeUndefined();
    expect(items[1].note).toBeUndefined();
  });

  it('4. 表头行（A列=编号）被跳过，不当作数据', async () => {
    const filePath = writeTempXlsx([headerRow, ...dataRows]);
    const items = await parseChecklistXlsx(filePath);
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain('编号');
    // 无表头文件：全部行都是数据
    const noHeader = writeTempXlsx(dataRows);
    const items2 = await parseChecklistXlsx(noHeader);
    expect(items2).toHaveLength(2);
    expect(items2[0].id).toBe('S01');
  });
});

describe('filterItems', () => {
  const items: ChecklistItem[] = [
    { id: 'H-01', clause: 'a', command: 'cat /etc/hosts' },
    { id: 'H-02', clause: 'b', command: 'cat /etc/passwd' },
    { id: 'H-03', clause: 'c', command: 'ss -tlnp' },
  ];

  it('无 only 时返回全量清单', () => {
    expect(filterItems(items, undefined)).toHaveLength(3);
  });

  it('only 指定编号时只保留对应项且保持原顺序', () => {
    const filtered = filterItems(items, 'H-03,H-01');
    expect(filtered.map((i) => i.id)).toEqual(['H-01', 'H-03']);
  });

  it('only 含空格与空段时应容错', () => {
    const filtered = filterItems(items, ' H-02 , ');
    expect(filtered.map((i) => i.id)).toEqual(['H-02']);
  });

  it('only 含未知编号时抛错且错误信息含该编号', () => {
    expect(() => filterItems(items, 'H-01,H-99')).toThrow(/H-99/);
  });
});
