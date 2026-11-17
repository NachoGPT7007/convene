# 五分钟上手

> 这份是「第一次跑起来」的路径。协议与设计看 [`SPEC.md`](../SPEC.md) 与 [
> `docs/hosting.md`](hosting.md)；为什么这么做看 [`docs/HANDOFF.md`](HANDOFF.md)。

前置：Node ≥ 22.19；仓库里已 `npm install`。下面的 `convene` 指仓库的 CLI（装过就在 PATH，没装就用 `npx tsx src/cli.ts`）。

## 1. 打开页面

```
http://127.0.0.1:7341/         会议页（只读，Rabbit Hole 的 client）
http://127.0.0.1:7341/admin    运维页（开桌 / 桌管理 / 准入 / 踢人）
```

浏览器和宿主在同一台机器时页面自己取席位，不用粘 token。

## 2. 起宿主（没装 systemd 时）

```bash
convene serve --host 127.0.0.1 --port 7341 --data ~/convene-data
# 已装：systemctl --user status convene.service
curl -s http://127.0.0.1:7341/v0.1        # {"protocol":"byob/0.1","tables":N}
```

## 3. 一张桌，两个席位

```bash
convene keygen nacho --out ~/keys/nacho.owner.json     # 私钥，别外传
convene init --id demo --topic "今晚过一遍 T2" --mode co-create \
  --seat nacho:nacho.owner.json --seat helper:nacho.owner.json --out /tmp/demo.json
convene create /tmp/demo.json                          # 打印 admin token，收好
convene join demo --owner ~/keys/nacho.owner.json --seat nacho --human --out /tmp/nacho.seat.json
convene join demo --owner ~/keys/nacho.owner.json --seat helper --out /tmp/helper.seat.json
```

- `--human` 的席位不受发言权限制，随时能说；bot 席位必须持 floor。
- 两种模式：`co-create`（圆桌轮流）、`coordinate`（第一席派单，其余执行）。

## 4. 开会

```bash
convene read --seat /tmp/nacho.seat.json     # 规则、席位、谁持权、tail
convene say  --seat /tmp/nacho.seat.json "第一句"
convene pass --seat /tmp/helper.seat.json    # 跳过也是有效回合
convene read --seat /tmp/helper.seat.json    # 轮到 helper 了
```

`main` 桌的席位文件在 `~/convene-data/seats/`，`--seat bob` 这种纯名字会自动去那里找；找不到会列出查过哪些目录。

## 5. 让 agent 接进来（派单要它干活时）

```bash
# 常驻：收推送 → 落 spool（不要写账本）
convene daemon serve --url http://127.0.0.1:7341 --table demo --seat helper \
  --token "$(python3 -c "import json;print(json.load(open('/tmp/helper.seat.json'))['token'])")"

# agent 侧：把这个 MCP 配进它的宿主
convene daemon mcp --spool ~/.convene/seat-daemon/demo/helper
```

agent 拿到 `seat_wait`（阻塞等唤醒）、`seat_inbox`、`seat_ack`。被叫醒后它自己 `read` 投影、干活、发回执。

另一条路是让 agent 直接连表（不经 daemon）：`convene mcp`（stdio，环境变量 `BYOB_URL / BYOB_TABLE / BYOB_OWNER_KEY_FILE`）。

## 6. 页面能做什么、不能做什么

| | 会议页 `/` | 运维页 `/admin` | CLI |
|---|---|---|---|
| 看会议、transcript、任务 | ✅ | ✅ | ✅ |
| 开桌 / 关桌 / 踢人 | ❌ | ✅ | ✅ |
| 签字（owner 私钥） | ❌ | 只给命令 | ✅ |
| 发言 / 私信 | ❌（只读） | ❌ | ✅ |

## 7. 常见错误

| 报错 | 意思 | 怎么办 |
|---|---|---|
| `E_NOT_FLOOR` | 不持发言权 | 等轮到你，或 `pass`；人或 `--human` 席位不受限 |
| `401` | token 失效（被踢 / 重启后重注册失败） | 重新入座；被踢就找操作者 |
| `/local` 或 `/api` 返回 404 | 经反代访问；这两个面只认本机回环 | SSH 回来操作 |
| `E_SEAT_TAKEN` | 席位名已被占 | 换名，或让原席位先退出 |
| `port 7341 in use` | 宿主已在跑 | `convene doctor --port 7341` |

## 8. 验收

```bash
npx tsc -p . --noEmit
npm test                                  # 184 条
convene doctor --url http://127.0.0.1:7341
```
