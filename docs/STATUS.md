# convene 状态清单

> 更新：2026-11-17 19:15 CST ｜ 基准：上游 `b00862b` ｜ 本仓领先上游 **28 个提交**
> 判定标准：**只有能指到代码、测试或实测输出的才算完成**。设计文档里的"定了"不等于做完了。
> 要整体接手，先读 [`HANDOFF.md`](HANDOFF.md)。

规模：`src/` 22 个文件 2997 行，`packages/seat-daemon/` 9 个源文件 + `schemas/wake.json`，`test/` 19 个文件 **169 条**（上游 73 条保持全绿），`web/` 单文件 1193 行，`schemas/` 8 个。

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
| `system/join_request` / `join_admitted` / `join_rejected` | 陌生人可**无席位**发起加入请求（用自己的私钥签自己的公钥）；管理员在看板上点「允许」写入账本，重放即生效；拒绝同样落账本 | `test/admission.test.ts` |
| `system/seat_removed` | 踢人：写一条系统事件，重放可还原；撤销该席位全部 token（401 而非 404）；持权者被踢时自动交接发言权，无人则关桌 | `test/local.test.ts` |

`projection.prefix.seats` 现带上 `transport / runtime / grants / badge` —— 此前 `grants` 未传，前端「权限」栏是**假阴性**，已修。

### 2. CLI（17 个子命令）

`serve`（`--host/--port/--data`，SIGTERM 优雅关闭）· `keygen` · `init`（`--mode co-create|coordinate`、`--seat name:keyfile|ownerId`、`--owner id:publicKey`）· `create` · `join` · `read` · `say` · `dm` · `dm inbox` · `pass` · `propose` · `approve` · `mcp` · `doctor` · `service` · `ui` · `kick`

`--seat` 接受 `alice` / `alice.seat.json` / 相对路径 / 绝对路径：纯名字先查数据目录（`~/convene-data/seats`、`./data/seats`），含分隔符的先按给定路径；找不到时报出**查过的每一处**与**实际有哪些席位**，不再是裸 ENOENT。

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

### 7. seat daemon（T1，2026-11-17）

表把「该你了」推给席位，daemon 落本地 spool，agent 空闲时来取。**只读搬运，绝不写账本。**

| 部分 | 内容 | 证据 |
|---|---|---|
| push 形状 | `packages/seat-daemon/schemas/wake.json`：A2A push-notification 形状，`wakes` ∈ `floor/task/dm/mention`；先冻 schema 再写代码 | `checkWake` 校验，坏 body 400 |
| 订阅 | `POST/DELETE /v0.1/tables/:id/subscriptions`，seat token 认证，只有本席位能订/退自己的；`(seat, url)` 幂等，重启复用同一 id；持久化 `subscriptions.json`（不入账本） | `test/subscriptions.test.ts` |
| 唤醒判定 | `src/wake.ts` 纯函数：floor 看 `data.holder` 或地址；task 看 `task_opened/task_state` 的地址；dm 只叫收件人；mention 只算非 system 条目 | `test/seat-daemon.test.ts` |
| 投递 | 写在账本之后异步 POST，超时 1.5s、重试 2 次、4xx 不重试；**先过 `canSee`**，推送只带裁剪字段，正文永不出现在 push 里；失败只记日志，不拖慢写者 | `test/subscriptions.test.ts`（含「receiver 全挂账本照写」） |
| spool | `wakes.jsonl` append-only + fsync 后才回 200；`cursor.json` 原子替换；重启重放；同一 `(table, seq)` 去重；残行截断 | `test/seat-daemon.test.ts` |
| 本地 MCP | `seat_wait`（阻塞到有未读或超时）、`seat_inbox`、`seat_ack`、`seat_status`；与 receiver **分进程**，靠 spool 文件交接 | InMemory MCP 测试 3 条 |
| 补拉 | daemon 停机期间推送会丢（重试后放弃），重启时与 `seat_wait` 等待中按 cursor 读 `projection?since=` 补回，再跑同一套 wake 规则 | 实测：停机漏 1 条 → 重启 `caught up: 1` |
| 常驻 | `convene daemon unit` 只打印 systemd user unit（token 走 `envfile` 的 0600 文件，不上命令行），不代装；停/启/回滚命令随 unit 一起打印 | 实测 unit 文本 |

**实测（隔离端口 7399/7392，2026-11-17 19:08 CST）**：dm 推送 147 ms 到达 spool、floor 交接 16 ms（验收要求 2 s）；daemon 停机时发的 dm 不在 spool，重启后 catch-up 补 1 条；agent 连续两次拉起，3 条未读都在；`seat_ack` 后未读归零、cursor 落盘。线上 `convene.service` 已重启，新订阅端点在 `main` 桌返回 401（无 token）。

---

## 二、未完成（按依赖排序，之后照此执行）

| 编号 | 事项 | 依赖 | 验收判据 |
|---|---|---|---|
| **T2** | 入座确认的**公开表单页**（现在只有看板弹窗，陌生人还不知道去哪发起） | T1 | 陌生人打开一个页面填公钥即发起请求 |
| **T3** | `join-request.attendance`（live / standby / autonomous，默认 standby） | 无 | 投影可见；不传按 standby；`reset_depth` 不因此升格 |
| **T4** | 跨机实测（WSL ↔ Fedora） | T1 | 两台机器各一席位，同一张桌跑通一轮 |
| **T5** | `access.yaml` 规则合成器（自建三样之二） | 无 | 三处白名单合成一份，两个网关由它生成 |
| **T6** | Cloudflare Access + Service Token（P3） | T4 | 外部 agent 带 token 能连，不带 401 |
| **T7** | 踢人的席位级授权（owner 对 `seat_removed` 签名） | 无 | A 能否踢 B 由签名决定，不由 admin token 决定 |
| **T8** | 表克隆（按现有成员复制一张新桌） | 无 | 加人已由准入解决；克隆用于「换拓扑重开」 |
| **T9** | 第二个 principal / 多主人 | T3 | 两个人类各持密钥，地位平等 |
| **T10** | 限流状态持久化 | 无 | 重启后限流窗口不丢 |
| **T11** | SSE 重连退避（现为固定 3 秒） | 无 | 断线后指数退避，不刷服务 |
| **T12** | 准入的**席位级授权**（现在任何本机操作者都能批） | T2 | 只有被授权的席位能批准，而不是「谁在本机谁算」 |

**已明确不做**：

- 按模式分 git 分支 —— 用 `mode` 字段 + 策略注册表；
- 引入 Matrix —— AS 是 passive，阻止不了事件，真 floor 做不了；
- Codync 的 P2P 网络 —— 本机 TUN 下会退回 relay，已有 Tailscale 够用；
- 改 `SPEC.md` —— 那是上游原文。扩展以 `schemas/` 与代码为准，上游接受后再补规范；
- 适配上游的 Rabbit Hole miniapp **当唯一前端** —— 它是 MiniMax Code 的 mini app：`start(context)` 要宿主注入 `dataDir/pluginRoot/signal/agent`，UI 走 `/api/*` 和它自己的 `service.mjs`（与本仓 `src/` 平行的第二套应用层），本机没装宿主。**不**代表它不可借鉴：`client/`（1486 行，MIT）可以 fork 出来接 `/v0.1`，代价是补 `dm`/`join_*`/`seat_removed` 渲染、去掉宿主桥、移植本机免登录与桌管理。当前选择是 `web/`，是否迁移待定，见 HANDOFF。

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
| `convene ui --seat seats/alice.seat.json` 报裸 ENOENT | 体验：相对路径依赖当前目录 | 席位查找器：名字/相对/绝对都认，报错列出查过哪里、有哪些 |
| 桌子只绑 `127.0.0.1`，tailnet 上的人连不到 | 能力缺口 | 绑 `0.0.0.0`；`/local/*` 对外仍 404 |
| 公网打开只看到一个要 token 的框 | 体验：像登录失败 | 明确说明「这不是登录」并给出两种进入方式 |
| `wakeFor` 把 `floor_granted`/`task_opened` 同时算成 mention | 语义：一条投递报两个原因，唤醒就不再有区分度 | mention 只算非 system 条目 |
| STATUS 说 Rabbit Hole「不含本项目的新字段」 | 文档与事实不符：`vendor/table-core.mjs` 就是本仓 HEAD 的 bundle，含全部新逻辑 | 已改写，理由换成「宿主型 mini app + 第二套应用层」 |
| 推送失败即丢（daemon 停机超过重试窗口） | 能力缺口：重启机器后期间消息消失 | 重启与等待中按 cursor 读 projection 补拉，实测补回 1 条 |

**待决**：`round` 语义 = decision 计数，不是 policy 回合。一轮若没出 decision，`round` 不前进。要不要另加 `turn` 字段？

---

## 四、执行顺序

```
T1 ✅ seat daemon ──> T2 入座确认 ──> T4 跨机实测 ──> T6 公网入口
T3 attendance ──────┘                    │
T5 access.yaml ──────────────────────────┘
T7 踢人授权 · T8 表克隆 · T10 限流持久化 · T11 退避 —— 无依赖，可随时插入
T9 第二主人 —— 需要 T3
```

理由：**先单机再跨机**。协议理解错了再跨机调试，代价是十倍。T1 已落地，下一步 T2。

---

## 五、判据

一件算完成，需要同时满足：

1. **有代码**，且在 `npm test` 里有一条测试覆盖它（跳过测试的行为不算）；
2. **有实测**，真实跑过一次并把输出留在提交说明里（"应该能行"不算）；
3. **可重放**，涉及账本的行为，重启后状态一致；
4. **不破兼容**，`schemas/` 只加不删，老客户端不传新字段照常工作；
5. **有回滚**，动了本机配置的，说明怎么退回去。
