# D19 实验：mini-multi-agent → mini-koda 三接口打通

> 目标：让「某多 Agent 编排服务」这一侧铸造代表**某一个用户**的 JWT，mini-koda 这一侧用
> JWKS 公钥验签之后，开放 inject / memory / usage 三类接口，并用 `externalId` 保证同一个外部
> 事件重复送达也只产生一条记录。做完你就能回答「两个服务之间凭什么信任对方」，
> 以及「凭证泄露之后，最多丢多少东西」。

## 你会学到

- 实现一个铸造用户级 JWT 的接口，包含必要的 claims
- 在另一个服务里用 JWKS 公钥验证这个 JWT
- 实现 inject/memory/usage 三个接口，接受经过验签的请求
- 给每个请求带上 externalId，重复调用验证不会产生第二条记录
- 跑一次完整的跨服务调用链路

## 目录

- `starter/`：挖了 5 个练习点的起始代码，`MOCK=1` 下可以直接跑
- `solution/`：参考答案
- `docker-compose.yml`：本 lab 自己的 Postgres，只有跑真实版才需要

两个变体的 `src/` 结构相同，业务代码只写了一遍：

```text
src/index.ts          入口：自检 / 常驻两种模式，两个服务都在这一个进程里起
src/agent/issuer.ts   调用方：RSA 密钥对、铸造用户级 JWT、发布 /.well-known/jwks.json
src/agent/client.ts   调用方：带 Authorization 头调三个接口（请求体里不带身份）
src/koda/server.ts    被调用方：验签钩子、requireScope、inject / memory / usage
src/koda/events.ts    幂等：externalId 加命名空间 + 唯一约束裁定
src/shared/types.ts   共享类型与 scope 枚举
src/infra/index.ts    Store 接口 + 内存实现 + 唯一的选择点
src/infra/real.ts     pg 的真实实现（sessions/messages 来自 D8、memories 来自 D12、
                      usage_ledger 来自 D13，本天不改；本天只新增 external_events）
```

## 怎么跑

```bash
cd starter            # 或 solution
pnpm install --ignore-workspace

# 验收入口：在一个进程里起「调用方」和「被调用方」两个服务，跑完九项检查后退出
MOCK=1 SELFTEST=1 pnpm start

# 常驻模式：两个服务都留着，并打印一张现成的 token 供手动 curl（Ctrl-C 退出）
MOCK=1 pnpm start
```

常驻模式下手动验证（把打印出来的 token 填进 `TOKEN`）：

```bash
export TOKEN=eyJhbGciOiJSUzI1NiIs...
curl -s http://127.0.0.1:4019/.well-known/jwks.json          # 公钥集合，任何人都能拉
curl -s http://127.0.0.1:3019/v1/usage -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:3019/v1/inject -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"externalId":"evt-1","text":"我的订单到哪了"}'         # 再发一次，返回 duplicate
```

`MOCK=1` 下**零外部服务**：不需要 Postgres、不需要 Docker、不需要 API key。本天没有模型调用，
唯一的外部依赖是数据库，走 `src/infra/index.ts` 里的内存实现——它不是打桩，
`external_events.external_id` 那条唯一约束被真实实现了一遍（用一个 Set），
所以幂等在离线状态下也是真的生效，而不是假装生效。

两个服务的端口：被调用方（mini-koda）**3019**，调用方（签发 token 的那一侧）**4019**。

想跑真实版：

```bash
docker compose up -d   # 在本 lab 根目录，起 postgres:16-alpine，宿主端口 5519
cd solution
DATABASE_URL=postgres://koda:koda@127.0.0.1:5519/koda SELFTEST=1 pnpm start
# 同一份业务代码，只有「存储：real」那一行不同；建表语句在 src/infra/real.ts
docker compose down -v # 收工
```

> 说明：`starter/` 与 `solution/` 都不属于仓库根 pnpm workspace（根 `pnpm-workspace.yaml` 只包含
> `apps/*`），`pnpm install` 时要加 `--ignore-workspace`。

## 验收标准

1. `MOCK=1 SELFTEST=1 pnpm start` 九项自检全部 ✅，退出码为 0（`starter/` 原样跑只有第 1、3、9 项 ✅，
   其余六项各自点名一个练习点）。
2. 第 1、2 项证明令牌本身是对的：JWKS 端点只发公钥（有 `n` / `e` / `kid`，没有私钥参数 `d`），
   铸造出的 token claims 恰好是 `sub` / `iss` / `aud` / `scope` / `jti`（加 `iat` / `exp`），有效期 900 秒。
3. 第 4、5、6 项证明拦得住：篡改过载荷的 token 返回 401，一分钟前就过期的 token 返回 401，
   只被授予 `inject:write` 的 token 去查 usage 返回 403。
4. 第 7 项证明幂等：同一个用户拿同一个 `externalId` 投两次，第二次返回 `duplicate`，
   `external_events` 里仍然只有一条、会话里也只有一条消息；换一个用户用**相同的** `externalId`
   却必须成功（幂等键带了命名空间）。
5. 第 8、9 项证明身份只来自 token：请求体里写 `"userId": "u-victim"` 完全无效，记忆仍然落在
   token 的 `sub` 名下；usage 只汇总自己的账，合计 $0.000728（2 次 chat + 1 次 embedding）。

## 常见坑

- **验签只验签名，忘了验 `aud`。** 这是最隐蔽的一个洞：签发方给别的下游服务签的 token，
  签名一样是合法的，你不校验 `aud` 就等于替别人的接口开门。`iss` / `aud` / `exp` 三样一个都不能少，
  `jwtVerify` 的第三个参数里全都能配。
- **把 `decodeJwt` 当验签用。** `decodeJwt` 只是 base64 解码，签名一眼都不看——本实验练习 2
  的初始状态就是这个写法，跑一下第 4 项自检你会看到把 `sub` 改成别人的 id 照样 201。
  这不是理论风险，是一改就能复现的。
- **幂等键不加命名空间。** `externalId` 是调用方自己生成的，两个调用方各自造出 `evt-1`
  是迟早的事。不加命名空间的后果不是报错，是**后来的那个用户静默收不到消息**——
  他的事件被当成重复投递丢掉了，日志里干干净净。
- **用「先查一下有没有，没有再插」实现幂等。** 单进程测试永远是对的，一上多实例就出双份。
  裁判必须是数据库那条唯一约束（`on conflict (external_id) do nothing` 返回零行就是重复），
  这条 D8 已经立过，跨服务这一层同样适用。
- **真库模式下反复跑自检。** 表里的数据会累积，所以自检开头会 `truncate` 那几张表；
  自己加检查项时记得这一点，否则第二次跑就会因为「上一次的记录还在」而变红。
