# Dify Proxy（源码无侵入优化）

这个代理用于在**不改动 Cline 项目源码**的前提下，对 Dify 流式返回做增强处理，目标是缓解：

- 同一 `conversation_id` 里回复经常“做一点就停”
- 流式 `answer` 在“全量/增量”格式切换时导致拼接异常
- 前一次任务未彻底结束导致后一次请求行为不稳定

## 核心能力

1. **流式 `answer` 自适应归一化**
   - 如果上游返回“全量 answer”，直接替换
   - 如果上游返回“增量片段”，自动追加
   - 对下游统一输出稳定的 `answer`（更适配当前 cline dify provider 的处理模式）

2. **同会话可选自动取消旧任务**（默认开启）
   - 维护 `user + conversation_id -> task_id` 映射
   - 新请求到来时可先尝试调用 `/chat-messages/{task_id}/stop`

3. **透明透传其他 Dify API**
   - 非 `/chat-messages` 路径原样转发

## 启动

```bash
DIFY_UPSTREAM_BASE_URL="https://your-dify.example/v1" \
PORT=4000 \
AUTO_CANCEL_PREVIOUS=1 \
PROXY_LOG=1 \
node scripts/dify-proxy/server.mjs
```

## 在 Cline 中使用

把 Dify Base URL 改成代理地址（例如）：

```text
http://127.0.0.1:4000
```

其他配置（如 API Key）保持不变。

> 这样你无需再改 `src/core/api/providers/dify.ts`，即可应用这层优化。

## 环境变量

- `DIFY_UPSTREAM_BASE_URL`（必填）：真实 Dify API 地址，通常是 `.../v1`
- `PORT`（可选，默认 `4000`）
- `HOST`（可选，默认 `0.0.0.0`）
- `AUTO_CANCEL_PREVIOUS`（可选，默认 `1`）
- `PROXY_LOG`（可选，`1` 开启日志）

## 健康检查

- `GET /healthz` -> `{ "ok": true }`
