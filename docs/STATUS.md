# convene 状态清单

> 更新：2026-11-17 01:10 CST ｜ 基准：上游 `b00862b` ｜ 本仓领先上游 **20 个提交**
> 判定标准：**只有能指到代码、测试或实测输出的才算完成**。设计文档里的"定了"不等于做完了。

规模：`src/` 20 个文件 2691 行，`test/` 15 个文件 **130 条**（上游 73 条保持全绿），`web/` 单文件 1193 行，`schemas/` 8 个。

---

## 一、已完成

### 1. 协议扩展（全部只加不删，老客户端不传照常工作）

| 扩展 | 内容 | 证据 |
|---|---|---|
| `ledger-entry.kind: "dm"` | 私信落账本；可见性四分支（发件人 / 收件人 / `read_dm_all` / 其余 **404**）；点对点，拒 `*` 与 `role:`；限流：每对席位突发 5 条、之后 2 分钟 1 条、10 分钟内重复拒收 | `test/dm.test.ts` |
| `ledger-entry.round` | 由 Table Core 填写：落账时已有的 decision 数；投影 `floor.round` 带当前轮次；旧账本重放时补盖 | `test/dm.test.ts` |
| `capability-card.grants` | 四项默认 false，由主人签名；`read_dm_all` 已生效，其余三项仅存储 | `test/dm.test.ts`、`test/badge.test.ts` |
| `capability-card.badge` | `svg` + `color`，签在卡里；渲染前剥离 `script/image/use/a/style/foreignObject` 与全部 `on*` | `test/badge.test.ts`；浏览器实测恶意徽章未执行 |
| `capability-card.runtime` | 入座时客户端自动探测 `os/host/agent` 并签入卡；WSL 用 `/proc/version` 判定（环境变量在 systemd 下为空） | `test/runtime.test.ts`；实测 `Ubuntu 26.04.1 LTS（WSL）· TERABYTE · dsh` |
| `system/seat_removed` | 踢人：写一条系统事件，重放可还原；撤销该席位全部 token（401 而非 404）；持权者被踢时自动交接发言权，无人则关桌 | `test/local.test.ts` |

`projection.prefix.seats` 现带上 `transport / runtime / grants / badge` —— 此前 `grants` 未传，前端「权限」栏是**假阴性**，已修。

### 2. CLI（17 个子命令）

`serve`（`--host/--port/--data`，SIGTERM 优雅关闭）· `keygen` · `init`（`--mode co-create|coordinate`、`--seat name:keyfile|ownerId`、`--owner id:publicKey`）· `create` · `join` · `read` · `say` · `dm` · `dm inbox` · `pass` · `propose` · `approve` · `mcp` · `doctor` · `service` · `ui` · `kick`

### 3. 前端（`GET /`，单文件无构建）

- 三栏看板：席位 / 账本 / 任务（<1180px 任务折行，<860px 单列）
- 发言、私信、收件箱（按席位分组、收发分列）
- 任务操作：开始 / 回执 / 通过 / 打回；**审批只给命令**（需 owner 私钥，页面不持有）
- 开桌向导：双模式、生成命令、**「现在就建」**（本机公钥齐全时直接建表）
- 桌管理：本机所有桌 + 成员四层身份 + 关闭 / 删除 / 踢人
- 扫描本机（桌 / 席位 / 公钥）、一键链接进入（token 走 `#` 片段，不落服务端）、深色/浅色
- **本机免登录**：浏览器和宿主在同一台机器时，页面自己从 `/local/state` 取席位并连上，不需要链接；
  多个席位时先让人选一次，选择被记住；token 失效（401）会自动走同一条路，不把人丢回表单。
  经反代访问时该接口是 404，免登录不生效，仍需一次性链接——这正是想要的边界

### 4. 本地运维接口（回环 + 无转发头）

`GET /local/state` · `POST /local/tables`（接受完整 config 或向导简化表单）· `POST /local/tables/<id>/close` · `DELETE /local/tables/<id>` · `POST /local/tables/<id>/seats/<seat>/remove`；`--no-local` 可整体关闭。带 `x-forwarded-for` / `cf-connecting-ip` / `x-real-ip` 一律 404。

### 5. 运维

`convene.service`（systemd user，跑源码不经 dist，改完 `restart` 即生效）· `fragmerge-home.service` · `convene doctor`（node / schemas / 端口 / 代理 / `no_proxy` / tailnet / 数据目录 / `--github` 实测两条路 / `--url` 验证反代）· `~/.dsh-proxy.sh` 已排除 `100.64.0.0/10`

### 6. 文档

`README.md` + `README.zh.md`、`CREDITS.md` + `CREDITS.zh.md`、`CONTRIBUTING.md` + `CONTRIBUTING.zh.md`、`docs/deploy-proxy.md`、`docs/hosting.md`

---

## 二、未完成（按依赖排序，之后照此执行）

| 编号 | 事项 | 依赖 | 验收判据 |
|---|---|---|---|
| **T1** | seat daemon：webhook 接收 + 本地 spool + 本地 MCP | 无（骨架已在 `packages/seat-daemon`） | 杀掉 agent 再拉起，未读还在；floor 变更 2 秒内到达 |
| **T2** | 首次入座人类确认（Ed25519 join + 入座表单页） | T1 | 新席位入座需人确认一次 |
| **T3** | `join-request.attendance`（live / standby / autonomous，默认 standby） | 无 | 投影可见；不传按 standby；`reset_depth` 不因此升格 |
| **T4** | 跨机实测（WSL ↔ Fedora） | T1 | 两台机器各一席位，同一张桌跑通一轮 |
| **T5** | `access.yaml` 规则合成器（自建三样之二） | 无 | 三处白名单合成一份，两个网关由它生成 |
| **T6** | Cloudflare Access + Service Token（P3） | T4 | 外部 agent 带 token 能连，不带 401 |
| **T7** | 踢人的席位级授权（owner 对 `seat_removed` 签名） | 无 | A 能否踢 B 由签名决定，不由 admin token 决定 |
| **T8** | 表克隆（按现有成员复制一张新桌） | 无 | 加人只能建新表的补丁 |
| **T9** | 第二个 principal / 多主人 | T3 | 两个人类各持密钥，地位平等 |
| **T10** | 限流状态持久化 | 无 | 重启后限流窗口不丢 |
| **T11** | SSE 重连退避（现为固定 3 秒） | 无 | 断线后指数退避，不刷服务 |

**已明确不做**：

- 按模式分 git 分支 —— 用 `mode` 字段 + 策略注册表；
- 引入 Matrix —— AS 是 passive，阻止不了事件，真 floor 做不了；
- Codync 的 P2P 网络 —— 本机 TUN 下会退回 relay，已有 Tailscale 够用；
- 改 `SPEC.md` —— 那是上游原文。扩展以 `schemas/` 与代码为准，上游接受后再补规范；
- 适配上游的 Rabbit Hole miniapp —— 它用 `apps/rabbit-hole` 里的 `table-core` 副本，不含本项目的新字段；本项目的前端是 `web/`。

---

## 三、本会话新增（发现问题并修掉）

| 问题 | 性质 | 处理 |
|---|---|---|
| 投影 prefix 不带 `grants` | 假阴性：有权限也显示「权限 无」 | prefix 已带 |
| 反代从本机转发时 `remoteAddress` 也是 127.0.0.1 | 安全：公网可读到 seat token | 转发头一律 404 |
| `npm run build` 把 `test/` 编进 `dist/`，测试跑两遍 | 测试数字骗人（106→187） | `vitest.config.ts` 只收 `test/` |
| systemd unit 指向 `dist/`，改源码不生效 | staleness 陷阱 | 改跑源码（tsx），`dist` 只在 `--from dist` 时用 |
| `parseSeatSpec` 用 `lastIndexOf`，路径含冒号时切错 | 正确性 | 改首个冒号 |
| 开桌向导 `keygen`/`--owner` 对同一人重复生成 | 冗余 | 按人类 ID 去重 |
| `humans` 是字符串数组却用 `[human]` 解构 | 正确性（取到首字母） | 已改 |
| `POST /local/tables` 匹配过宽，吞掉 close 路由 | 正确性 | 加长度判断 |
| 🔒 emoji 在无 emoji 字体的环境显示成方框 | 兼容 | 改 `[私信]` 文本 |
| home 门面有两份代码（Windows 计划任务 + 本仓副本） | 改错地方，白做两轮 | 真源收到 WSL（`FRAGMERGE_HOME_HOST=0.0.0.0` + wslrelay），Windows 任务 Disabled |
| 每次打开看板都要粘 token | 体验：本机明明能自己取 | 本机免登录 + 记住偏好席位 |

**待决**：`round` 语义 = decision 计数，不是 policy 回合。一轮若没出 decision，`round` 不前进。要不要另加 `turn` 字段？

---

## 四、执行顺序

```
T1 seat daemon ──> T2 入座确认 ──> T4 跨机实测 ──> T6 公网入口
T3 attendance ──┘                    │
T5 access.yaml ──────────────────────┘
T7 踢人授权 · T8 表克隆 · T10 限流持久化 · T11 退避 —— 无依赖，可随时插入
T9 第二主人 —— 需要 T3
```

理由：**先单机再跨机**。协议理解错了再跨机调试，代价是十倍。T1 是所有跨机与唤醒能力的地基。

---

## 五、判据

一件算完成，需要同时满足：

1. **有代码**，且在 `npm test` 里有一条测试覆盖它（跳过测试的行为不算）；
2. **有实测**，真实跑过一次并把输出留在提交说明里（"应该能行"不算）；
3. **可重放**，涉及账本的行为，重启后状态一致；
4. **不破兼容**，`schemas/` 只加不删，老客户端不传新字段照常工作；
5. **有回滚**，动了本机配置的，说明怎么退回去。
