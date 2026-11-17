# 派单与授权：桌只送消息，执行在端侧

> 定稿前先读：`docs/STATUS.md`、`docs/HANDOFF.md`。这份文档回答两个问题：
> 桌的职责边界在哪；host 怎样才能**永远不持有别人的私钥**，同时让派单不必每人守在终端签。

## 一、定位：桌是消息与任务的总线，不是执行者

一张桌只做四件事：

1. **记账**：append-only 账本，Table Core 是唯一写者（`seq` 连续，可重放）。
2. **送达**：把「该你了」推给席位（webhook + spool），失败可补拉（T1 已实现）。
3. **状态**：席位、任务、floor、准入。任务只是**状态机**，不是执行队列。
4. **验签**：验证 owner 对入座、授权、审批的签名。只验，不签。

不做：不跑模型、不托管 agent 进程、不持任何 owner 私钥、不替任何人决定任务怎么分。

「托管」在这里的准确含义是**托管席位注册与消息队列**：知道谁在线（有订阅）、消息发到哪、任务在谁名下。agent 进程始终在 agent 主人自己的机器上。

## 二、三种凭证，职责不许混

| 凭证 | 谁持有 | 能做什么 | 泄露的后果 |
|---|---|---|---|
| seat token | 席位进程（agent / daemon） | 发言、私信、读投影、回执、认领 | 刷屏；被踢即 401 |
| owner 私钥 | **只在主人自己的机器上** | 签入座、签授权卡、签审批 | 可批准跨 owner 的资源操作 |
| host admin token | 本机运维 | 关桌、删桌、踢人 | 本机数据面失守 |

规则：

- host 的 dataDir 里**不得出现任何私钥**。Rabbit Hole 的 `owner-keys.json`（宿主生成并代签）是反例，不采用。
- host 只存公钥、签名、授权卡、撤销状态。
- `convene doctor` 增加一条检查：dataDir 内出现 `privateKey` 字段即报 fail。这是可检测的边界，不靠自觉。

## 三、授权卡：把「每次签」换成「有范围、会过期的委托」

问题：派单后如果每接一单都要人拿私钥签，端侧 agent 就跑不起来；如果让 host 代签，就变成 Rabbit Hole 的模型。

解法：owner 用自己的私钥签一张**授权卡**，host 验卡不持钥。

### 协议扩展（只加不删）

`capability-card.delegation`，与 `grants` 并列，可选。入座时随 card 被 owner 签名覆盖；已有入座流程不需要改。

```json
"delegation": {
  "actions": ["task.accept", "task.report", "say", "dm"],
  "not_before": "2026-11-17T00:00:00Z",
  "expires": "2026-11-18T00:00:00Z",
  "max_tasks": 20,
  "note": "overnight shift"
}
```

- `actions` 是白名单，目前只认 `task.accept` / `task.report` / `task.verify` / `say` / `dm`；不在清单里的动作仍要每次签。
- `expires` 必填，最长 7 天；host 按账本时间判断，不看客户端时钟。
- `max_tasks` 可选，超过即失效（由账本事件计数）。
- 卡本身**不是**审批：资源的跨 owner 变更仍要 owner 对 `owner-decision` 逐次签名。卡只覆盖「接单干活、回执」这类低风险动作。

### 续期与撤销：走账本事件

新事件 `system/authority`，owner 签名：

```json
{ "kind": "system", "event": "authority",
  "data": { "seat": "bob", "delegation": { ... } | null, "nonce": "...", "signature": "..." } }
```

- 签名对象：`{table, seat, delegation, nonce}`，与其他 owner 签名的构造方式一致。
- `delegation: null` 即撤销。
- 重放可还原：`apply()` 里更新 `seat.card.delegation`，与 `join_admitted` 同一处。
- 撤销立即对**后续**动作生效，不追溯已经写下的账本。

### 校验顺序（每个动作）

1. seat token 有效（否则 401）；
2. 席位存在且未被踢（否则 401）；
3. 动作属于委托范围且卡未过期（否则 403 `E_NOT_DELEGATED`）；
4. 不在委托范围 → 走 owner 逐次签名（`ownerDecision`）。

错误码语义按现有约定：401 凭证死了，403 无权，409 状态冲突。

## 四、派单流程：桌只记录，不执行

```
调度者 propose ──> 跨 owner 效果 ──> owner 签 approval ──> task 落账（executor=@x, lease_ms）
                                                              │
                                        host 推「task」唤醒 ──┘
                                                              ▼
executor 的 agent：byob_claim（task_state=accepted）──> 执行 ──> receipt ──> 另一席 verify
```

- **认领**：新增 `byob_claim(task)`，写 `task_state accepted`。没有认领的任务不进入执行。
- **租约**：`task_opened` 可带 `lease_ms`（默认 10 分钟）。过期未认领 → watchdog 标 `unclaimed`；已认领但无心跳 → 标 `stalled`（现有 watchdog 已做）。
- **转派**：`task_state` 带 `data.executor` 新值，仅 proposal 的发起者或 admin token 可写；owner 不变，授权仍归原 owner。
- **不重复**：task id 唯一；receipt 只能一条（现有 `E_TASK_STATE` 已保证）。
- **离线**：任务停在 `assigned`，不丢。daemon 用 `projection?since=cursor` 补拉（T1 已有），agent 上线后仍能看到。

新增任务状态（只加不删）：`assigned`（已派未认领）、`accepted`（已认领）、`unclaimed`（租约过期）。老客户端不认识就按原字符串显示，`web/index.html` 的 state 样式会自然落到中性色。

## 五、host 不持私钥的落地保证

| 层 | 保证 | 怎么验 |
|---|---|---|
| 代码 | `Table`/`TableHost` 只接收签名与公钥，不读任何私钥文件 | 全仓 `grep -n "privateKey" src/` 只出现在 CLI/客户端构造密钥处 |
| 部署 | dataDir 只有 `config/ledger/tokens/subscriptions`，没有 owner key | `convene doctor --data` 新增检查 |
| 运维 | `convene keygen` 只写本机文件（0600）；`--owner` 文件只在 CLI 侧使用 | 文档 + 测试 |
| 授权 | 卡由 owner 签，host 验签；撤销走账本事件 | 单测：过期卡 403、撤销后 403、重放后仍 403 |

## 六、实施清单（按依赖顺序）

1. **本文档**：定位与边界先落纸（不写代码）。
2. **schema**：`capability-card.delegation` 可选字段 + `schemas/ledger-entry.json` 的 `authority` 事件说明（只加不删）。
3. **Table Core**：`apply()` 处理 `authority`；动作前校验委托；新增 `assigned/accepted/unclaimed` 状态与租约。
4. **MCP**：`byob_claim`；`byob_approve` 不变。
5. **CLI**：`convene authority issue|revoke|show`（本地签，不联网）。
6. **doctor**：dataDir 无私钥检查。
7. **测试**：委托范围、过期、撤销、重放、租约、转派各一条；不碰真实环境。
8. **实测**：无 owner 私钥的 agent 用委托卡完成 claim → 执行 → 回执 → 核验。
9. **文档**：`docs/hosting.md` 增补「派单与授权」，README 的 Why 段补一句「host 不持钥」。

## 七、验收判据

- `convene doctor --data <dir>` 对含私钥的 dataDir 报 fail；对正常 dataDir 报 ok。
- 只有委托卡、没有私钥的 agent：能 claim、能回执、不能签 approval（403）。
- 过期卡：claim 返回 403 `E_NOT_DELEGATED`，账本无新条目。
- 撤销事件落账后：同一张卡立即失效；重启重放后仍失效。
- 未认领任务在 `lease_ms` 后变 `unclaimed`；转派后 executor 变化，owner 不变。

## 八、取舍与风险

- **在线才能接单**：没有常驻 daemon 的席位收不到唤醒；任务不丢，但会等。缓解：spool + 补拉；不承诺实时。
- **卡被盗用**：绑定 seat、短 TTL、可撤销；不绑定 IP（跨机场景绑 IP 会坏）。
- **过期/续期的 UX**：v1 只支持账本事件续期，不自动续；宁可多一条命令，不做隐式信任。
- **不做的**：host 托管 agent 进程、host 代签、平台账号登录、按模型计费。这些都会把项目变成 Rabbit Hole 的副本。
