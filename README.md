# audit-pilot —— 等保/基线核查辅助工具

在远程 Linux 服务器上执行等保（等级保护）复测/安全基线核查时的辅助 CLI 工具：解析核查清单 → **只读白名单安全审查** → SSH 逐条采集 → 按规则自动判定 → 输出初筛报告与人工截图取证脚本。

## 用途

配合 MCP/运维终端对目标机做基线核查时，工具承担五件事：

1. **解析核查清单**：JSON 或 XLSX（每条核查项 = 一条只读命令 + 符合/不符合判定正则）
2. **安全审查（guard）**：执行前用只读白名单审查每条命令，拦截一切危险命令——这是安全底线，防止 LLM 或清单中混入危险命令
3. **采集**：通过 SSH 在目标机逐条执行（仅执行 guard 放行的命令）
4. **判定**：逐项判定 符合（pass）/ 不符合（fail）/ 待人工确认（manual），并提取证据行
5. **产物**：初筛报告（Markdown）+ 截图取证脚本（仅 fail/manual 项，供人工复制命令到终端执行并截图留证）

## 安装

```bash
npm install   # Node.js v18+
npm run build # 可选：tsc 编译到 dist/
```

## 用法

```bash
# JSON 清单
npx tsx src/cli.ts --json examples/sample.json --host 127.0.0.1 --port 2222 --user root --pass xxx --out out

# XLSX 清单（列序：A=编号 B=核查项 C=命令 D=符合标准 E=不符合标准 F=备注，首行表头自动跳过）
npx tsx src/cli.ts --xlsx checklist.xlsx --host 192.168.1.10 --user auditor --key ~/.ssh/id_rsa

# 无参数：打印用法说明，退出码 0
npx tsx src/cli.ts
```

| 参数 | 说明 |
| --- | --- |
| `--json <path>` | JSON 格式核查清单（`ChecklistItem` 数组） |
| `--xlsx <path>` | XLSX 格式核查清单（与 `--json` 二选一） |
| `--host` / `--port` | 目标机 SSH 地址 / 端口（默认 22） |
| `--user` | SSH 用户名 |
| `--pass` / `--key` | SSH 密码 / 私钥路径（二选一） |
| `--timeout <ms>` | SSH 连接超时（默认 15000） |
| `--out <dir>` | 输出目录（默认 `out`） |
| `--dry-run` | 只打印执行计划（命令 + guard 预审），不连接服务器、不执行 |
| `--interactive` | Web 审批模式（与 `--dry-run` 互斥，详见下文「Web 审批」） |
| `--only <ids>` | 只送审/执行指定编号（逗号分隔，如 `--only H-01,H-03`） |

### 清单格式（JSON）

```json
[
  {
    "id": "S01",
    "clause": "应禁止SSH空口令登录",
    "command": "grep -E '^\\s*PermitEmptyPasswords\\s+yes' /etc/ssh/sshd_config",
    "failPattern": "PermitEmptyPasswords\\s+yes",
    "note": "命中 failPattern 判不符合"
  },
  {
    "id": "S03",
    "clause": "应限制root远程登录",
    "command": "grep -Ei '^PermitRootLogin' /etc/ssh/sshd_config",
    "passPattern": "PermitRootLogin\\s+(no|prohibit-password)",
    "note": "命中 passPattern 判符合；两者皆不中 → manual"
  }
]
```

`passPattern` / `failPattern` 为正则源字符串，逐行匹配命令输出（支持 `...90$` 这类行锚定）；同时命中时 **fail 优先**。

### 输出产物

- `<out>/report.md`：初筛报告（统计摘要 + 逐项结论表格）
- `<out>/screenshot-script.md`：截图取证脚本（仅 fail/manual 项，每块含执行命令、预期说明、初筛输出节选）
- `<out>/audit-log.jsonl`：命令安全审查审计日志（**拦截与放行均记录**，JSONL）

## Web 审批（--interactive）

核查命令执行前的最后一道人工关卡：CLI 在本地起一个**仅监听 127.0.0.1** 的审批页，人工在浏览器里逐条查看命令并勾选放行后，CLI 才会建立 SSH 连接并执行被放行的命令。

```bash
npx tsx src/cli.ts --json examples/checklist-3.json --host 127.0.0.1 --port 2222 --user root --pass xxx --out out --interactive
```

流程：读取清单 → 逐条 guard 预审 → 启动审批页并在终端醒目打印审批 URL（win32 自动尝试打开默认浏览器）→ 人工在页面上勾选 → 点「放行所选并执行」或「拒绝」：

- **放行**：仅对勾选的项建立 SSH 连接并执行（guard 预审拦截的项在页面上标红、复选框禁用，无法放行）；执行期间页面每 1.5 秒轮询状态，完成后直接在页面展示逐项结论（编号 | 符合/不符合/待人工 | 证据行）
- **拒绝 / 5 分钟超时**：不建立任何连接、不执行任何命令，CLI 以退出码 0 结束
- `--only` 可与 `--interactive` 组合（先过滤再送审）

安全说明：

- **仅本机监听**：HTTP server 只绑定 `127.0.0.1`，局域网/远程地址无法访问（有测试锁定非环回地址不可达）
- **一次性 token**：审批 URL 带 48 位十六进制随机 token，所有接口（页面、放行、拒绝、状态轮询）都校验 token，错 token 一律 403；server 关闭即失效
- **超时自动拒绝**：默认 5 分钟无人操作自动按拒绝处理，不会静默等待；做出决定后重复提交返回 409
- **放行范围受控**：API 层只接受 guard 预审放行集合内的编号（含拦截项或未知编号 → 400），空放行同样被拒绝，防止"放行全部"的旁路
- 默认端口 8787，被占用时自动向后尝试最多 20 个端口

## guard 只读白名单规则（安全核心）

每条命令执行前按以下顺序审查，任一环节不通过即拦截（不执行、判定为 manual、记入审计日志）：

1. **拆段**：按 `;` `&&` `||` `|` 拆分为子命令段（拆分跳过引号内的字符——引号内的 `|` 不是 shell 管道，例如 `grep -E '(a|b)'` 的正则交替不会误拆）
2. **段首白名单**：每段必须以下列只读命令开头，否则拦截（"命令不在只读白名单"）：
   `cat head tail ls stat grep egrep fgrep awk sed -n ps ss netstat lsof id whoami uname hostname df du mount free uptime env printenv getent ulimit`、`systemctl status/show/list-units/list-unit-files/is-enabled/is-active`、`service <名> status`、`chkconfig --list`、`crontab -l`、`rpm -qa/-q`、`dpkg -l/-s`、`openssl version`、`java -version`、`nginx -v/-V`、`httpd -v`、`mysqld/mysql --version`、`find wc cut sort uniq which whereis file dmidecode lscpu lsblk`、`ip addr/route/link`、`ifconfig ping -c echo date`
3. **段内黑名单子串**：任一命中即拦截，包括 `rm`、`mkfs`、`dd`、`shutdown`、`reboot`、`halt`、`poweroff`、`init 0/6`、`kill*`、`chmod/chown/chattr`、`user*/group*`、`passwd`、`su/sudo`、`eval`、`export`、`source`、反引号、`$(`、`base64`、`xargs`、`tee`、`curl/wget/nc/ssh/scp`、脚本解释器（`bash/sh/python/perl/ruby` 等）、`iptables/firewall-cmd/ufw`、`systemctl start/stop/restart/...`、`mv/cp/touch/mkdir/rmdir`、`vi/vim/nano`、`find -delete`、`find -exec`
4. **重定向检查**：段内禁止 `>` `>>` `<`，唯一例外是精确形式 `2>/dev/null`

两点误伤消解（均不降低安全性，且有测试锁定）：

- `passwd`、`curl/wget/nc/ssh/scp` 按**命令位置**匹配：`/etc/passwd`、`/etc/ssh/sshd_config` 这类路径不拦截；作为命令被调用（段首/管道后/空白后）照拦；绝对路径调用（如 `/usr/bin/rm`）由第一道段首白名单兜底拦截
- 拆段尊重引号：引号外的 `ls; reboot`、`echo x | bash` 照常拆段拦截

## 判定逻辑（judge）

按序判定：被 guard 拦截 → manual（命令被安全审查拦截）；SSH 执行失败/无退出码 → manual；`failPattern` 命中 → fail；`passPattern` 命中 → pass；其余 → manual（需人工确认）。证据 = 命中行及其前后各 1 行上下文（去重拼接）。

## 测试方式

```bash
npm test        # vitest run：6 个测试文件、75 个用例（guard 33 / judge 9 / checklist 9 / collector 5 / report 7 / approval-server 12）
npm run build   # tsc 编译（零错误）
```

本项目按 TDD（红→绿→重构）开发：每个模块先写失败测试、再实现使其通过；guard 的两处误伤 bug（路径含 `ssh`、引号内 `|` 拆段）均先以失败测试固化再修复。

## 项目结构

```
src/
  guard.ts       # 只读白名单 guard + JSONL 审计日志（安全核心）
  checklist.ts   # JSON/XLSX 清单解析
  collector.ts   # guard 审查 + 逐条执行采集（strip-ansi、失败不中断）
  judge.ts       # pass/fail/manual 判定 + 证据提取
  report.ts      # 初筛报告 + 截图取证脚本渲染
  ssh.ts         # ssh2 CmdRunner（连接/exec/合并输出/close）
  approval-server.ts # Web 审批页（仅 127.0.0.1 + 一次性 token + 超时自动拒绝，零依赖 node:http）
  cli.ts         # 命令行入口（参数解析、流水线编排、统计输出、--interactive 审批流程）
tests/           # vitest 测试（*.test.ts）
examples/sample.json  # 等保风格样例清单（8 条，含拦截演示项）
```
