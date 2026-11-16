# 参与贡献

[English](CONTRIBUTING.md) · 中文

谢谢来帮忙摆桌子。

## 基本规矩

- **协议优先。** 改线上格式、账本条目、任务状态或错误码，先改 [SPEC.md](SPEC.md) 和 [`schemas/`](schemas/) 里对应的文件。代码跟着规范走，不是反过来。
- **Table Core 是唯一写者。** 新增的行为必须能从账本精确重放出来。
- **桌上不放凭据。** 任何能让桌子宿主代替主人行动的东西，都不属于这个仓库。
- PR 小一点、聚焦一点，每个行为变更配一个测试。
- **扩展只加不删。** convene 跟的是 `upstream/main`：新 schema 字段必须是可选的，Table Core 负责给默认值，不传它的客户端必须照常工作。这个 fork 不删、不改名 `SPEC.md` 与 `schemas/` 里的任何东西。做不到就先作为提议提给上游。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run demo:scripted     # 离线端到端跑一遍
```

`npm run demo:mcode` 需要 `mcode` 在 `PATH` 里，以及 `MINIMAX_BENCH_KEY` 里的 MiniMax API key。密钥、主人密钥文件（`*.owner.json`）、席位文件、`data/` 目录一律不要提交。

## 图

图放在 [`docs/assets/`](docs/assets/)，`.excalidraw` 源文件和 PNG 并排放。在 [excalidraw.com](https://excalidraw.com) 改源文件，导出 2x PNG，两个一起提交。图上的标签必须和代码、SPEC.md 完全一致。

## 许可

本项目用 [Developer Certificate of Origin](https://developercertificate.org/)，不用 CLA。每个提交都要签名：

```bash
git commit -s
```

这会加一行 `Signed-off-by:`：你声明这个改动是你写的，或者你有权提交它。贡献即表示你同意按 [MIT 许可](LICENSE) 发布你的贡献。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
