import fs from 'node:fs';
import path from 'node:path';

/**
 * 只读白名单 guard —— 安全底线模块。
 *
 * 任何来自核查清单的命令在执行前都必须经过 assertCommandSafe 审查：
 *  1. 按 `;` / `&&` / `||` / `|` 拆段
 *  2. 每段依次做：段首白名单 → 段内黑名单子串 → 重定向检查
 *  3. 全部通过才放行
 */

export interface GuardResult {
  ok: boolean;
  blockedSegment?: string;
  reason?: string;
}

/** 段首只读命令白名单（允许前导空白） */
const WHITELIST = new RegExp(
  '^(cat|head|tail|ls|stat|grep|egrep|fgrep|awk|sed -n|ps|ss|netstat|lsof|id|whoami|uname|hostname|df|du|mount|free|uptime|env|printenv|getent|ulimit|systemctl (status|show|list-units|list-unit-files|is-enabled|is-active)|service [a-z0-9_.-]+ status|chkconfig --list|crontab -l|rpm -qa|rpm -q|dpkg -l|dpkg -s|openssl version|java -version|nginx -v|nginx -V|httpd -v|mysqld --version|mysql --version|find|wc|cut|sort|uniq|which|whereis|file|dmidecode|lscpu|lsblk|ip addr|ip route|ip link|ifconfig|ping -c|echo|date)\\b'
);

/** 段内危险子串黑名单：任一命中即拦截 */
const BLACKLIST: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\b/, label: 'rm 删除' },
  { pattern: /\bmkfs/, label: 'mkfs 格式化' },
  { pattern: /\bdd\b/, label: 'dd 裸写磁盘' },
  { pattern: /\bshutdown\b/, label: 'shutdown 关机' },
  { pattern: /\breboot\b/, label: 'reboot 重启' },
  { pattern: /\bhalt\b/, label: 'halt 停机' },
  { pattern: /\bpoweroff\b/, label: 'poweroff 关机' },
  { pattern: /\binit\s+[06]\b/, label: 'init 切换运行级别' },
  { pattern: /\bkill/, label: 'kill 进程' },
  { pattern: /\bchmod\b|\bchown\b|\bchattr\b/, label: '权限变更命令' },
  { pattern: /\buser(add|del|mod)\b|\bgroup(add|del|mod)\b/, label: '用户/组管理命令' },
  // 注意：passwd 需按“命令位置”匹配——前面若是路径/单词字符（如 /etc/passwd）不算命中，
  // 否则会误伤 `cat /etc/passwd` 这类只读核查命令；仅作为命令被调用时拦截。
  { pattern: /(?<![\w./~-])passwd\b/, label: 'passwd 改密' },
  { pattern: /\bsu\b|\bsudo\b/, label: '提权命令' },
  { pattern: /\beval\b/, label: 'eval 动态执行' },
  { pattern: /\bexport\b/, label: 'export 环境变量' },
  { pattern: /\bsource\b/, label: 'source 执行脚本' },
  { pattern: /`/, label: '反引号命令替换' },
  { pattern: /\$\(/, label: '$( 命令替换' },
  { pattern: /base64/, label: 'base64 编解码' },
  { pattern: /\bxargs\b/, label: 'xargs 组合执行' },
  { pattern: /\btee\b/, label: 'tee 写文件' },
  // 网络客户端命令同样按“命令位置”匹配：/etc/ssh/sshd_config 这类路径中的 ssh 不算命中；
  // 作为命令被调用（段首、管道后、空白后）才拦截。绝对路径调用（/usr/bin/curl 等）
  // 由第一道段首白名单拦截，安全性不受影响。
  { pattern: /(?<![\w./~-])(curl|wget|nc|ssh|scp)\b/, label: '网络客户端命令' },
  { pattern: /\bpython|\bperl\b|\bruby\b|\bbash\b|\bsh\b|\bzsh\b/, label: '脚本解释器' },
  { pattern: /iptables|firewall-cmd|ufw/, label: '防火墙变更命令' },
  {
    pattern: /systemctl (start|stop|restart|reload|disable|enable|mask)/,
    label: 'systemctl 变更服务状态',
  },
  { pattern: /\bmv\b|\bcp\b|\btouch\b|\bmkdir\b|\brmdir\b/, label: '文件系统变更命令' },
  { pattern: /\bvi\b|\bvim\b|\bnano\b/, label: '交互式编辑器' },
  { pattern: /-delete/, label: 'find -delete 删除动作' },
  { pattern: /-exec/, label: 'find -exec 执行动作' },
];

/** 唯一允许的重定向精确形式 */
const ALLOWED_REDIRECT = '2>/dev/null';

/**
 * 将命令按 ; && || | 拆分为非空段。
 * 拆分时跳过单引号/双引号内的字符——引号内的 | ; 不是 shell 分隔符
 * （如 grep -E '(a|b)' 的交替正则），引号外的分隔符照常拆分。
 */
export function splitSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null; // 引号闭合（单引号内无转义，双引号简化同处理）
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    // 引号外：识别 ; && || |
    if (ch === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === '&') {
      if (cmd[i + 1] === '&') {
        segments.push(current);
        current = '';
        i++;
        continue;
      }
      current += ch; // 单个 & （后台执行）不是命令分隔，保留
      continue;
    }
    if (ch === '|') {
      segments.push(current);
      current = '';
      if (cmd[i + 1] === '|') i++; // 吞掉第二个 |
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 重定向检查：先移除精确的 `2>/dev/null`，剩余部分不得出现 > >> < */
function checkRedirect(segment: string): string | null {
  const rest = segment.split(ALLOWED_REDIRECT).join('');
  if (rest.includes('>') || rest.includes('<')) {
    return '包含重定向符号（仅允许精确形式 2>/dev/null）';
  }
  return null;
}

/**
 * 审查单条命令是否只读安全。
 * 放行 → { ok: true }；拦截 → { ok: false, blockedSegment, reason }
 */
export function assertCommandSafe(cmd: string): GuardResult {
  const segments = splitSegments(cmd);
  for (const segment of segments) {
    // a. 段首白名单
    if (!WHITELIST.test(segment)) {
      return { ok: false, blockedSegment: segment, reason: '命令不在只读白名单' };
    }
    // b. 段内黑名单子串
    for (const { pattern, label } of BLACKLIST) {
      if (pattern.test(segment)) {
        return { ok: false, blockedSegment: segment, reason: `包含危险片段（${label}）` };
      }
    }
    // c. 重定向检查
    const redirectReason = checkRedirect(segment);
    if (redirectReason) {
      return { ok: false, blockedSegment: segment, reason: redirectReason };
    }
  }
  return { ok: true };
}

/**
 * 追加一条 JSONL 审计日志（同步写）。
 * 无论命令被拦截还是被放行执行，都应记录，留痕备查。
 */
export function appendAuditLog(
  logPath: string,
  entry: { time: string; command: string; ok: boolean; reason?: string }
): void {
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(logPath, line, 'utf8');
}
