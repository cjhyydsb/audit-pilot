# audit-pilot —— 等保/基线核查辅助工具

在远程 Linux 服务器上执行等保（等级保护）复测/安全基线核查的 CLI 工具：**解析核查清单 → 只读白名单安全审查 → SSH 逐条采集 → 按规则自动判定 → 初筛报告 + 人工截图取证脚本**。

内置三重护栏，放心让 LLM/自动化参与核查：命令白名单 guard（危险命令一律拦截）、Web 审批页（执行前人工看命令点按钮放行）、全量审计日志。

## 快速开始（新机器 3 步）

要求：**Node.js v18+**（含 npm）、git、本机能 SSH 到目标服务器。无需安装 MobaXterm。

```bash
# 1. 克隆并安装
git clone https://github.com/cjhyydsb/audit-pilot.git
cd audit-pilot
npm install

# 2. 30 秒自检（不需要任何服务器：预览样例清单将执行的命令）
npm run check -- --json examples/checklist-3.json --dry-run

# 3. 第一次核查（把清单/服务器/账号换成你的）
npm run check -- --xlsx 我的核查清单.xlsx \
  --host 192.168.1.10 --port 22 --user audit_ro --pass '***' \
  --out reports/服务器A --interactive
```

第 3 步会自动弹出浏览器审批页：逐条看命令 → 勾选 → 点「放行所选并执行」。结果落盘到 `--out` 目录。

## 推荐核查工作流

```
核查 Excel ──► 转成清单(json/xlsx)（列格式见下）
   │
   ▼
① --dry-run 预览执行计划（不连服务器，给客户/领导看命令清单也用它）
   │
   ▼
② --interactive 执行：浏览器审批页勾选放行 → 自动采集+判定
   │        （guard 预审拦截的命令在页面上标红、禁选，想放行也放不了）
   ▼
③ 看产物：report.md（初筛结论）/ screenshot-script.md（给人工截图用）
   │
   ├─ pass 项 ──► 直接进报告，无需截图
   └─ fail/manual 项 ──► 按 screenshot-script.md 逐条在终端执行并截图留证
   │
   ▼
④ 整改后重跑同一条命令 → 新旧 report.md 对比即整改证据，审计日志全程留痕
```

## 核查清单格式

### XLSX（推荐，等保 Excel 直接按此列序整理）

首个工作表，列序固定，首行表头自动跳过：

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| 编号 | 核查项 | 命令 | 符合标准(正则) | 不符合标准(正则) | 备注 |

### JSON

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

**判定规则**（`passPattern`/`failPattern` 为正则源字符串，逐行匹配命令输出）：

- 命中 `failPattern` → **不符合（fail）**；同时命中两者时 fail 优先
- 命中 `passPattern` → **符合（pass）**
- 都不中 / 没配规则 → **待人工确认（manual）**
- 命令被 guard 拦截或 SSH 执行失败 → manual（如实注明原因）

> 经验：规则正则的边界值要写准（例：要求 ≤90 天，failPattern 写 `PASS_MAX_DAYS\s+\d{3,}$` 而不是 `[6-9]\d\d`——后者会把 600 这类合规边界值误圈进去）。可先用 `--dry-run` + 小范围执行验证规则再全量跑。

完整样例见 `examples/sample.json`（8 条等保条款，含危险命令拦截演示）与 `examples/checklist-3.json`（3 条最小样例）。

## 命令参数

所有执行入口统一为 `npm run check -- <参数>`（等价于 `npx tsx src/cli.ts <参数>`）：

| 参数 | 说明 |
| --- | --- |
| `--json <path>` | JSON 格式核查清单（与 `--xlsx` 二选一） |
| `--xlsx <path>` | XLSX 格式核查清单（列序见上） |
| `--host` / `--port` | 目标机 SSH 地址 / 端口（默认 22） |
| `--user` | SSH 用户名 |
| `--pass` / `--key` | SSH 密码 / 私钥路径（二选一） |
| `--timeout <ms>` | SSH 连接超时（默认 15000） |
| `--out <dir>` | 输出目录（默认 `out`；建议每台服务器一个目录） |
| `--dry-run` | 只打印执行计划（命令 + guard 预审），不连接服务器、不执行 |
| `--interactive` | Web 审批模式：起本地审批页，人工浏览器勾选放行后才执行（与 `--dry-run` 互斥） |
| `--only <ids>` | 只送审/执行指定编号（逗号分隔，如 `--only H-01,H-03`） |
| `--jump-host` 等跳板参数组 | 经堡垒机连接，见下文「经堡垒机核查」 |

无参数运行 `npm run check` 打印用法说明。

## 输出产物（`--out` 目录）

- `report.md`：初筛报告——统计摘要（总/pass/fail/manual/被拦截）+ 逐项表格（编号|核查项|命令|结论|证据行）
- `screenshot-script.md`：截图取证脚本——仅 fail/manual 项，每块含**执行命令、预期说明、初筛输出节选**，人工复制命令到终端执行、对照预期、截图留证
- `audit-log.jsonl`：命令安全审查审计日志（拦截与放行**均记录**，含时间戳）
- `plan.md`：执行计划（`--dry-run` 时生成）

## 经堡垒机/跳板机核查

目标机只能经堡垒机到达时，两种方式：

### 方式一：`--jump` 直连跳板（堡垒机支持标准 SSH 接入，如 JumpServer）

```bash
npm run check -- --xlsx 清单.xlsx \
  --host <目标机IP> --user audit_ro --pass '***' \
  --jump-host <堡垒机IP> --jump-port 22 --jump-user <堡垒机账号> --jump-pass '***' \
  --interactive
```

跳板参数组：`--jump-host` / `--jump-port`(默认22) / `--jump-user` / `--jump-pass` / `--jump-key`（后两者二选一；给了 `--jump-host` 则 user+凭据必填）。先连堡垒机，再经 forwardOut 通道到目标机，guard/审批/报告全套不变。

### 方式二：MobaXterm 本地端口转发（堡垒机需人工认证/输 OTP 时）

1. MobaXterm 工具栏 **Tunneling** → New SSH tunnel → **Local port forwarding**
2. 本地端口如 `22222`，SSH 服务器 = 堡垒机，转发目的地 = `目标机IP:22`
3. 在 MobaXterm 里人工完成堡垒机认证（输 OTP 也没问题），保持隧道开启
4. audit-pilot 连本地隧道口：

```bash
npm run check -- --xlsx 清单.xlsx --host 127.0.0.1 --port 22222 --user audit_ro --pass '***' --interactive
```

> 本工具不依赖 MobaXterm；方式二里 MobaXterm 只承担"人工过堡垒机认证 + 保持隧道"的通道角色。

## Web 审批（--interactive）

核查命令执行前的最后一道人工关卡：CLI 在本地起**仅监听 127.0.0.1** 的审批页，人工在浏览器逐条查看命令并勾选放行后，CLI 才建立 SSH 连接并执行。

流程：读取清单 → 逐条 guard 预审 → 启动审批页并在终端打印审批 URL（win32 自动尝试打开默认浏览器）→ 人工勾选 → 点「放行所选并执行」或「拒绝」：

- **放行**：仅对勾选项建立 SSH 并执行；执行期间页面每 1.5 秒轮询，完成后直接展示逐项结论（编号 | 符合/不符合/待人工 | 证据行）
- **拒绝 / 5 分钟超时**：不建立任何连接、不执行任何命令，退出码 0
- `--only` 可与 `--interactive` 组合（先过滤再送审）

安全设计：

- **仅本机监听**：只绑定 `127.0.0.1`，局域网/远程无法访问（有测试锁定非环回不可达）
- **一次性 token**：URL 带 48 位随机 token，所有接口校验，错 token 一律 403
- **超时自动拒绝**：默认 5 分钟无人操作按拒绝处理，不会静默等待
- **放行范围受控**：API 只接受 guard 预审放行集合内的编号（含拦截项或未知编号 → 400，空放行同样拒绝）
- 默认端口 8787，被占用自动向后尝试最多 20 个

## guard 只读白名单规则（安全核心）

每条命令执行前按序审查，任一环节不通过即拦截（不执行、判 manual、记审计日志）：

1. **拆段**：按 `;` `&&` `||` `|` 拆分（引号内不拆——`grep -E '(a|b)'` 的正则交替不会误伤）
2. **段首白名单**：每段必须以下列只读命令开头，否则拦截：
   `cat head tail ls stat grep egrep fgrep awk sed -n ps ss netstat lsof id whoami uname hostname df du mount free uptime env printenv getent ulimit`、`systemctl status/show/list-units/list-unit-files/is-enabled/is-active`、`service <名> status`、`chkconfig --list`、`crontab -l`、`rpm -qa/-q`、`dpkg -l/-s`、`openssl version`、`java -version`、`nginx -v/-V`、`httpd -v`、`mysqld/mysql --version`、`find wc cut sort uniq which whereis file dmidecode lscpu lsblk`、`ip addr/route/link`、`ifconfig ping -c echo date`
3. **段内黑名单子串**：任一命中即拦截——`rm`、`mkfs`、`dd`、`shutdown`、`reboot`、`halt`、`poweroff`、`init 0/6`、`kill*`、`chmod/chown/chattr`、`user*/group*`、`passwd`、`su/sudo`、`eval`、`export`、`source`、反引号、`$(`、`base64`、`xargs`、`tee`、`curl/wget/nc/ssh/scp`、脚本解释器（`bash/sh/python/perl/ruby` 等）、`iptables/firewall-cmd/ufw`、`systemctl start/stop/restart/...`、`mv/cp/touch/mkdir/rmdir`、`vi/vim/nano`、`find -delete`、`find -exec`
4. **重定向检查**：禁止 `>` `>>` `<`，唯一例外是精确形式 `2>/dev/null`

误伤消解（不降安全性，有测试锁定）：`passwd`、`curl/wget/nc/ssh/scp` 按**命令位置**匹配（`/etc/passwd`、`/etc/ssh/sshd_config` 等路径不拦，作为命令调用照拦）；绝对路径调用（`/usr/bin/rm`）由段首白名单兜底拦截。

## 判定逻辑（judge）

被 guard 拦截 → manual（注明拦截原因）；SSH 执行失败/无退出码 → manual；`failPattern` 命中 → fail；`passPattern` 命中 → pass；其余 → manual。证据 = 命中行及前后各 1 行上下文（去重拼接）。

## 常见问题

- **Node 版本**：需 v18+（`node -v` 查看）；审批页/测试依赖 Node 18 内置 fetch
- **命令总被判 manual**：多半是清单没配判定正则，或输出与正则不匹配——先 `--dry-run` 看命令，手工跑一遍对一下输出格式再调正则
- **`reboot`/`rm` 之类演示项**：`examples/sample.json` 里的 S06 是故意放的拦截演示，会被 guard 拦下（这正是预期行为）
- **核查账号建议**：生产环境建议建只读专用账号（配合 sudoers 白名单），不要用 root
- **npm 安装慢**：可 `npm install --registry=https://registry.npmmirror.com`

## 开发

```bash
npm test        # vitest run：7 个测试文件、80 个用例，全绿
npm run build   # tsc 编译（零错误）
```

本项目按 TDD（红→绿→重构）开发：每个模块先写失败测试、再实现使其通过。

```
src/
  guard.ts            # 只读白名单 guard + JSONL 审计日志（安全核心）
  checklist.ts        # JSON/XLSX 清单解析 + --only 编号过滤
  collector.ts        # guard 审查 + 逐条执行采集（strip-ansi、失败不中断）
  judge.ts            # pass/fail/manual 判定 + 证据提取
  report.ts           # 初筛报告 / 截图取证脚本 / 执行计划渲染
  ssh.ts              # ssh2 CmdRunner（支持 --jump 两跳经堡垒机）
  approval-server.ts  # Web 审批页（127.0.0.1 + 一次性 token + 超时自动拒绝，零依赖 node:http）
  cli.ts              # 命令行入口（参数、流水线、--dry-run/--interactive/--jump）
tests/                # vitest 测试
examples/             # 样例清单（sample.json 8 条 / checklist-3.json 3 条）
```

## 许可证

MIT
