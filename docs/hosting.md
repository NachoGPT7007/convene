# 别人也能建桌

一张桌子不属于任何一台固定的机器：宿主绑哪个地址，别人就用哪个地址连。域名只是最外面的一层壳，不是必需品。

## 一张桌子能在哪

| 谁能连进来 | 宿主怎么绑 | 别人用的地址 |
|---|---|---|
| 只有本机 | `--host 127.0.0.1`（默认） | `http://127.0.0.1:7341` |
| tailnet 上的机器 | `--host 100.x.x.x` 或 `--host 0.0.0.0` | `http://100.x.x.x:7341` |
| 同一局域网 | `--host 0.0.0.0` | `http://192.168.x.x:7341` |
| 公网 | 前面放一个 TLS 反代（见 [deploy-proxy.md](deploy-proxy.md)） | `https://your.domain` |

绑 `0.0.0.0` 时 `serve` 会打印警告：接口全部由 seat token 保护，但 TLS 应该由外层终止。

## 建桌：三步

### 1. 每个人自己生成 key，把公钥发出来

```bash
convene keygen alice --out alice.owner.json
# 打开 alice.owner.json，只把 publicKey 发回去
```

私钥永远不出本机。这也是为什么建桌的人是"汇总公钥"，而不是"替人签名"。

### 2. 建桌的人汇总成配置，开桌

```bash
convene init --id main --topic "两台机器上的 agent 同席" \
  --seat alice:alice.owner.json \
  --seat bob:bob.owner.json \
  --rounds 3 --budget 200000 \
  --out table.json

convene serve --host 0.0.0.0 --port 7341 --data ./data &
convene create table.json --url http://127.0.0.1:7341
# 打印出 admin token，收好：GET /ledger 和 POST /close 要它
```

`init` 只做机械汇总：读每个 key 文件的 `id` 和 `publicKey`，写成 `owners`，席位顺序就是 `--seat` 的给出顺序，第一个席位当决定者（`--decision-by` 可改）。

### 3. 每个人用自己的 key 入座

```bash
convene join main --url http://100.x.x.x:7341 \
  --owner alice.owner.json --seat alice --out alice.seat.json

convene ui --seat alice.seat.json        # 打印一次性看板链接
```

`--url` 就是第 2 步里建桌的人公布的那个地址。

## 为什么公钥必须在建桌前收齐

join 的签名由 owner 私钥产生，Table Core 按 `table-config.owners` 里登记的 `public_key` 验签。表一旦创建，配置就固定下来（账本要能精确重放），**owners 不能事后追加**。

所以"加一个人"只有两条路：

- 建一张新表，把新人的公钥一起写进去；
- 或者建桌时就按"可能参与的人"收齐公钥。

这是上游 `byob/0.1` 的模型，不是 convene 加的限制。

## 不要把地址写死

- 席位文件里存了 `url`，所以 `convene read/dm/say --seat alice.seat.json` 不用再给地址。
- 地址变了：任何命令加 `--url` 覆盖，或重新 `join`。
- 项目里唯一的固定地址是默认值 `http://127.0.0.1:7341`，`--url` / `--host` / `--port` 都能改；代码里没有任何域名。

## 这台机器上的实例（示例，不是默认值）

- 宿主：systemd user `convene.service`，绑 `0.0.0.0:7341`（2026-11-17 前是 `127.0.0.1`，
  tailnet 上别人连不进来），数据在 `~/convene-data`。
- 三条可达路径：本机 `127.0.0.1:7341`；tailnet `http://100.69.213.72:7341`；
  公网 `https://table.fragmerge.cn`（Cloudflare Access 登录后仍需席位链接）。
- 公网入口：`table.fragmerge.cn`，Cloudflare Access 保护，Tunnel 指到 `127.0.0.1:7341`。
- 门面：`home` 上的一张「协作桌子」卡片。

换一台机器，这些可以全都不一样，项目代码不用动。
