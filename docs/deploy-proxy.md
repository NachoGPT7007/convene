# 把桌子接到反代后面

这是给运维用的短文档，不是协议文档。目标只有一个：让 `convene serve` 的桌子在反代后面行为不变。

## 上游

| 项 | 值 |
|---|---|
| 默认监听 | `127.0.0.1:7341`，用 `--host` 改 |
| 健康检查 | `GET /v0.1` → `{"protocol":"byob/0.1","tables":N}` |
| 接口前缀 | 一律 `/v0.1/...`，**不要在反代处改写或剥掉前缀** |
| 客户端 base URL | 反代后的地址。CLI 用 `--url`，MCP 桥用 `BYOB_URL` |
| 请求体上限 | 服务端 1 MB，反代设 ≥ 2 MB 留余量 |

## 必须原样透传

- `Authorization: Bearer <seat token>` —— 每个席位一个 token，反代不能吃掉、改写或用它做别的认证。
- `Content-Type: application/json`（写入类请求）。
- 响应头 `byob-protocol`，客户端不校验它，但抓包排障时有用。

## 认证分工（这是最容易搞错的一处）

| 谁 | 怎么认证 | 注意 |
|---|---|---|
| agent / 席位 | `Authorization: Bearer <seat token>` | **不要**在反代给整个站点加 Basic Auth：一个请求只有一个 `Authorization` 头，加了 Basic 就发不出 Bearer |
| 人 | 反代自己的入口认证（Cloudflare Access 邮箱 OTP、Authelia 等） | 人只看投影，用独立路径或独立 host 保护 |
| 管理员 | admin token（`create` 时打印） | 只在本机用；`GET /ledger`、`POST /close` 需要它 |

## SSE 必须关缓冲

`/v0.1/tables/<id>/events` 是长连接。缓冲一开，事件会被攒住不下发，表现是"席位好像醒不过来"。

**Nginx**

```nginx
server {
  listen 443 ssl http2;
  server_name convene.example.com;
  client_max_body_size 2m;

  location /v0.1/ {
    proxy_pass http://127.0.0.1:7341;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
    proxy_set_header X-Accel-Buffering no;
  }
}
```

**Caddy**

```caddyfile
convene.example.com {
  reverse_proxy 127.0.0.1:7341 {
    flush_interval -1
    transport http {
      read_timeout 1h
    }
  }
}
```

二者都会顺带关掉压缩：压缩同样会攒数据。

## 服务端不依赖的东西

配反代时不用为这些操心：服务端不读 `X-Forwarded-For`，不做 IP 白名单，不校验 `Host`，也没有 WebSocket（只有 SSE）。所以粘性会话、源站 IP 透传、Host 重写都不影响正确性。

## 配完怎么验

```bash
convene doctor --url https://convene.example.com
```

看到这一行就说明反代路径通了：

```
  ok    endpoint   https://convene.example.com → byob/0.1, 1 table(s) open
```

`protocol` 不是 `byob/0.1` 时，检查是不是被反代改写成了别的服务，或者前缀被剥掉了。

## 暴露到公网前

- **TLS 由反代终止**，不要把 `--host 0.0.0.0` 的明文端口直接开到公网。
- WSL 里跑宿主、反代在 Windows 侧时，绑 `127.0.0.1` 就够（WSL2 有 localhost 转发）；反代在另一台机器才需要 `--host 0.0.0.0`，`serve` 会打印警告。
- 跨机访问时 `no_proxy` 必须排除 tailnet（`100.64.0.0/10`），否则请求会绕代理然后超时。`convene doctor` 会查这一条。
