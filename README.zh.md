# dsh-tier-router

[![npm](https://img.shields.io/npm/v/dsh-tier-router.svg)](https://www.npmjs.com/package/dsh-tier-router)
[![license](https://img.shields.io/npm/l/dsh-tier-router.svg)](./LICENSE)

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供按难度分级的自动模型路由。**

它注册一个虚拟模型 —— **Tier Router（自动路由）**——把它选为会话模型后，每次请求都会先判断
**难度**（困难 / 一般 / 简单）与**是否含图片**，再转发到你在「设置 → 模型」里已经配置好的模型上。

不需要额外的上游、也不需要额外的 API Key：路由目标就是你现有的模型——本地 Codex 路由、
llama.cpp 端点、官方 API，都可以。

[English →](./README.md)

## 为什么需要它

模型选择器让你「选一次，然后一直忍受」：选强模型，「谢谢，继续」也要付强模型的价钱；选便宜的
本地模型，遇到硬核重构就顶不住。`dsh-tier-router` 把这个选择变成**按请求**决定的：

- 寒暄、翻译、简短解释 → **简单**档（例如免费的本地模型）
- 日常写代码、改文件 → **一般**档
- 架构、调试、并发、迁移 → **困难**档
- 带图片的请求 → **视觉**档，先把图片转成结构化文本再作答

## 特性

- **三级难度路由** —— 启发式分类器（默认：零成本、零延迟、结果确定）、可选的 LLM 分类器，或 **Jev**
  （TypeSafe System One）：它不生成文本，而是把「该交哪一档」当成一道三选一的选择题来回答。三者都带缓存。
- **视觉侧车（vision sidecar）** —— 请求含图片时，先由视觉模型把图片转成结构化证据
  （摘要 / OCR / 版面），以文本替换原图片块，再由难度档位作答；也保留 `route` 旧模式，把整轮交给视觉档。
- **阶梯回退** —— 目标档位 → 其余档位（就近优先）→ 你的默认模型。`easy` 会先退到 `normal` 再到
  `hard`，本地小模型接不住的一句话提问不会被直接甩给最贵的路由；`normal` 与 `hard` 仍保持"先升档"。
- **fail-open** —— 只有在所有路由都失败时才产出 error finish chunk，绝不静默吞掉请求。
- **不改源码、不打补丁** —— 纯 adapter 级路由（`ctx.llm.registerAdapter` + `prepareCall`），
  Harness 本体一行未动。
- **自带设置卡片** —— 在「设置 → Tier Router」里从**实时模型目录**中挑选各档位模型
  （目录标注了是否支持图片、以及可用的推理强度），并能看到路由计数与最近失败。
- **推理强度两级语义** —— 聊天输入框的 Off/High 是总开关；打开后各档位使用自己配置的 effort。
- **递归安全** —— 任何指回路由器自身的档位会被跳过，路由不可能自环。

## 安装

```sh
dsh plugin --profile web add dsh-tier-router
```

然后重启 `dsh web`（宿主插件在启动时加载）。本包声明了 `dsh.bundle.patch`，`dsh plugin add`
会把它追加进 profile 的层栈，并由它自己的 `cordis.patch.yml` 插入插件行 —— **不要**再手动加一行。

也可以直接从 GitHub 安装（本包是纯 ESM，无构建步骤）：

```sh
dsh plugin --profile web add github:zhangzhangco/dsh-tier-router
```

**升级。** `dsh plugin add` 记录的是 caret 范围，而 `0.x` 版本的 caret 只锁**次版本**：
`^0.1.0` 永远不会解析到 `0.2.0`。所以要显式指定版本或 tag：

```sh
dsh plugin --profile web add dsh-tier-router@latest
```

另外，刚发布后本地安装可能仍从 pnpm 缓存的 registry 索引解析到上一个版本；直接钉住确切版本
（`dsh-tier-router@0.2.0`）一定会重新拉取。

## 快速开始

1. 打开 Web GUI →「设置 → Tier Router」，为四个档位各选一个 provider + model。
   下拉列表来自你已配置的全部模型，并标注 `✓ Vision` 与推理强度。
2. 在聊天输入框的模型选择器里选择 **Tier Router（自动路由）**。
3. 正常发消息即可。路由计数与最近失败在同一设置页。

> 本仓库内的默认值指向作者自己的本地路由（`codex-local`、`gpudev`）。请把四个档位改成你自己的模型。
> 留空的档位会被自动跳过并回退，不会让请求失败。

## 我怎么知道它选了哪个模型？

打开 **设置 → Tier Router**。计数器下方是 **最近路由决策**，列出最近 20 次请求（最新在上），
每条都显示：实际作答的模型、判定的档位、本次请求的估算长度、以及为什么走这条路由：

```
21:47:12  codex-local/gpt-5.6-terra  ·  hard  ·  ~181k tok（判据文本 92 字）  ·  由 heuristic  ·  新回合  ·  hard tier  ·  判据: 3 hard signal(s)
21:46:40  gpudev/qwen3.8-27b-q5  ·  easy  ·  ~2k tok（判据文本 2 字）  ·  由 heuristic  ·  同回合续跑  ·  easy tier  ·  判据: social signal(s) in short message
21:45:03  codex-local/gpt-5.5  ·  normal  ·  ~181k tok（判据文本 41 字）  ·  由 llm-cache  ·  同回合续跑  ·  normal tier  ·  跳过（上下文不够） gpudev/qwen3.8-27b-q5 (131072 < est 181000, easy tier (fallback))
```

有三个字段是专门为了让「档位为什么是这样」可解释而存在的：

- **`由 <分类器>`** —— 这一档是哪个分类器给出的：`heuristic`；`llm`、`llm-cache`、`llm-timeout`、
  `llm-error`、`llm-unavailable`；或 `jev`、`jev-cache`、`jev-low-confidence`、`jev-timeout`、
  `jev-auth`、`jev-rate-limit`、`jev-error`、`jev-unavailable`。因语义分类器超时、没配 Key 或主动
  弃权而回退到启发式的判定，会明确标出来，不再和真实分类结果长得一模一样。
- **`判据: …`** —— LLM 分类器自己给的一句话理由，或启发式的打分依据。路由原因（`normal tier`）
  回答的是「去了哪一档」，这里回答的是「为什么判成这一档」。
- **`判据: …`** —— 分类器自己给的理由：LLM 分类器返回的一句话，或启发式的打分依据。它回答「为什么判成这一档」，而路由原因回答「去了哪一档」。

### 两套分母，故意的

计数器那一行统计的是**请求数**；下面「按回合」那一行统计的是**人类回合数**。

在 agent 循环里，一条人类消息会在每个工具步骤重新发送一次，分类结果按完整分类输入及后端身份缓存；
工具状态变化会重新分类，同一回合可以使用不同档位。于是「按请求」计数会被任务恰好走了多少步加权 —— 它主要衡量的是
循环长度，不是工作量的难度构成。回合的身份用最后一条用户消息标识（会话 + 它在请求里的下标），
所以五步工具循环算一个回合，用户再发一条消息才算下一个回合。

「按回合」只记录回合开始时的档位，不代表后续所有步骤；想知道每一档实际承接了多少流量看「按请求」那一行。
两者差别很大时，说明请求口径正被少数几个长循环主导。

其中「跳过」就是上下文感知在起作用：那一档因为模型装不下本次请求而被略过。同样的数据也在 stats 接口上：

```sh
curl -s localhost:3080/tier-router/api/stats | python3 -m json.tool
```

`decisions` 是内存里的有界环形缓冲（20 条）——服务重启即清空，且它是**路由器自己的估算**，
不是计费用的真实 token 数。

## 长会话与小上下文模型

会话会变长，早先能接住的模型，到后面可能就装不下当前历史了。典型故障是把 180k token 的对话
交给一个 131k 窗口的本地 llama.cpp 端点：

```
400: request (180612 tokens) exceeds the available context size (131072 tokens)
```

`contextGuard`（默认开启）在**发请求之前**就处理这件事：对每个候选路由，路由器解析该模型的上下文窗口
（`resolveModelInfo().context.contextWindow`），凡是**已知**窗口小于本次请求估算长度的路由一律跳过，
于是阶梯会自动落到装得下的模型上。三个性质很重要：

- **窗口未知的模型永不拦截。** 不上报窗口的 provider 始终是候选；守卫只会丢掉它确实知道上限的模型。
- **绝不会把候选链清空。** 若所有路由都会被跳过，则原样使用原链 —— 本来能路由的请求绝不会变成“无路由”。
- **它是估算。** 请求长度按「CJK 1 字 ≈ 1 token、其它 3.5 字符 ≈ 1 token」（图片另计固定额度）估算，
  再留 10% 余量；且刻意偏向高估，因为估低了等于把装不下的请求发出去。

设 `contextGuard: false` 可关闭，退回纯按难度与档位顺序路由。模型下拉里也会显示每个模型的窗口
（`qwen3.8-27b-q5 · 131k ctx`），配置时就能看出哪一档撑得住长会话。

## 配置项

设置位于 `tier-router` 命名空间，全部为扁平字段。可在设置卡片中编辑，也可直接写 YAML：

```yaml
tier-router:
  enabled: true
  classifier: heuristic          # heuristic | llm | jev
  hardProvider: codex-local
  hardModel: gpt-6-astra
  hardEffort: ''                 # 例如 low / high / max；空 = 不指定
  normalProvider: codex-local
  normalModel: gpt-5.5
  normalEffort: ''
  easyProvider: gpudev
  easyModel: qwen3.8-27b-q5
  easyEffort: ''
  visionProvider: codex-local
  visionModel: gpt-6-astra
  visionEffort: ''
  visionMode: replace            # replace（结构化替换，默认）| route（整轮交给视觉档）
  visionCacheTtl: 3600           # 视觉证据缓存秒数；0 = 关闭
  visionFallbacks: []            # [{provider, model}] 视觉档的显式回退
  fallbackProvider: ''           # 最后兜底；空 = 使用会话默认模型
  fallbackModel: ''
  llmClassifierProvider: ''      # classifier: llm 时使用；空 = 复用简单档
  llmClassifierModel: ''
  # classifier: jev（TypeSafe System One）。Key 一般在设置卡片里粘贴；
  # TYPESAFE_API_KEY 与 ~/.typesafe/key 是后备来源。
  jevApiKey: ''                  # 接口永远不会把它回传给设置卡片
  jevModel: jev-latest
  jevBaseUrl: https://api.typesafe.ai
  jevMinConfidence: 0.3          # 低于此置信度 Jev 弃权、改由启发式判断（0 = 不设门槛）
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后请求走会话默认模型。 |
| `classifier` | `heuristic` | `heuristic`（内置打分）、`llm`（由模型生成判定）或 `jev`（TypeSafe System One 回答一道类型化选择题）。 |
| `hardScore` | `3` | 仅启发式：得分达到此值即判「困难」。改之前先看下一节。 |
| `hardProvider` / `hardModel` / `hardEffort` | `codex-local` / `gpt-6-astra` / `''` | 困难档。 |
| `normalProvider` / `normalModel` / `normalEffort` | `codex-local` / `gpt-5.5` / `''` | 一般档。 |
| `easyProvider` / `easyModel` / `easyEffort` | `gpudev` / `qwen3.8-27b-q5` / `''` | 简单档。 |
| `visionProvider` / `visionModel` / `visionEffort` | `codex-local` / `gpt-6-astra` / `''` | 视觉档。 |
| `visionMode` | `replace` | 视觉处理方式，见下文。 |
| `visionCacheTtl` | `3600` | 视觉证据缓存秒数。 |
| `visionFallbacks` | `[]` | 视觉档失败后、默认模型之前的显式回退。 |
| `fallbackProvider` / `fallbackModel` | `''` | 所有档位都未配置时使用的路由；空 = 会话默认模型。 |
| `llmClassifierProvider` / `llmClassifierModel` | `''` | `classifier: llm` 时使用的分类模型。 |
| `jevApiKey` | `''` | `classifier: jev` 使用的 TypeSafe Key；依次回退到 `TYPESAFE_API_KEY`、`~/.typesafe/key`。 |
| `jevModel` | `jev-latest` | Jev 判断使用的模型别名。 |
| `jevBaseUrl` | `https://api.typesafe.ai` | TypeSafe API 基址（会拼接 `/v1/systemone`）。 |
| `jevMinConfidence` | `0.3` | 低于此置信度即视为弃权、改由启发式判断；`0` = 不设门槛。 |
| `classifierTimeoutMs` | `4000` | 语义分类器（LLM 或 Jev）预算。超时则立刻改用启发式，慢分类的结果仍会写入缓存供后续请求使用。 |
| `visionTimeoutMs` | `60000` | 单次视觉旁路调用预算，避免视觉模型卡住整个回合。 |
| `contextGuard` | `true` | 跳过上下文窗口装不下本次请求的路由。 |

### `hardScore` 这个旋钮，以及它为什么不是解法

在一台机器的 213 条真实请求上实测，启发式的得分分布是退化的：

| 得分 | 条数 |
| ---: | ---: |
| 6 | 1 |
| 2 | 1 |
| 1 | 10 |
| **0** | **169（79%）** |
| -1 | 32 |

2 到 6 分之间没有任何样本，所以 `hardScore` 取 2、3、4、5 效果完全相同。真正有区别的只有两个值：
`3`（默认，213 条里判出 1 条困难）和 `1`（判出 12 条）。`0` 对闲聊是安全的（问候语得 -1 分），
而 schema 把取值钳在 0..10 —— 负阈值会把每句问候都判成「困难」。

这个旋钮的用途是**选择激进度，不是提升准确度**：79% 的请求落在同一个桶里，任何阈值都无法把
困难工作和日常改动分开。如果目标是路由质量，请改用语义分类器（`classifier: llm` 或 `classifier: jev`）。

## 路由规则

```
请求 ──► 含图片?
          ├─ 是 ─► visionMode=replace: 图片 → 视觉模型 → 结构化证据文本 ─┐
          │        visionMode=route:   整轮 → 视觉档                    │
          └─ 否 ───────────────────────────────────────────────────────┤
                                                                        ▼
                                   难度分类（启发式 / LLM / Jev）──► 档位链
                                        选中档 → 其它档（就近优先）→ 默认模型
```

**难度信号**为中英双语：代码块体积、文件引用数量、消息长度，以及 *架构 / 重构 / 并发 / 死锁 /
内存泄漏 / 分布式 / 迁移 / 性能 / 安全 / architecture / refactor / distributed / deadlock…* 等关键词。
累计得分 **≥ 3** 判为「困难」；含任务动词的消息至少为「一般」；寒暄、翻译、简短解释为「简单」。

有两个行为值得了解：

- **图片历史也算含图。** 请求携带完整会话历史，因此只要有**任一**历史消息含图片，整个请求就按含图处理
  —— 否则纯文本档位模型会以「does not support image input」拒绝整段历史。
- **`visionMode`。** `replace`（默认）让视觉模型只做辅助：它返回结构化证据，证据文本替换图片，
  最终由难度档位作答。`route` 是旧行为：整轮直接交给视觉档。

## 模型不可用时会发生什么

**某一档"服务不了"和"偶尔失败一次"是两件事。** 路由器读 harness 的失败码（`HarnessError.code`
—— harness 的契约明确写着"按 code 路由，绝不解析 message"），区别对待：

| 失败性质 | 失败码 | 路由器行为 |
| --- | --- | --- |
| **这条路由服务不了** | `QUOTA`、`AUTH`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL`、`NO_ADAPTER` | 立即换下一档，**并把该路由停用** `routeCooldownMs`（默认 5 分钟） |
| **只是这次出错了** | `TRANSPORT`、`TIMEOUT`、`SERVER`、`RATE_LIMIT`、`EMPTY_RESPONSE`、未知码 | 换下一档；只在窗口内连续失败 `routeFailureThreshold`（默认 2）次后才停用 |
| **是这次请求的问题，不是路由的问题** | `CONTEXT_WINDOW_EXCEEDED`、`ABORTED` | 换下一档，**永不停用**：下一个更小的请求很可能装得下 |

被停用的路由会被直接跳过 —— 它的失败不会被重复支付 —— 设置页会把它连同失败码、失败信息和剩余秒数列出来：

```
已停用路由（判定为当前不可用）: codex-local/gpt-6-astra — QUOTA (usage limit reached), 274s 后重试
```

任何一次成功都会清空该路由的失败计数；`routeCooldownMs: 0` 关闭停用机制；停用**永远不允许把路由链清空** ——
所有路由都被停用时仍然照常尝试，理由留在决策记录的 `skipped` 里（和上下文守卫一样的 fail-open）。

**为什么还需要"连续失败"这条规则：失败码并不总是有信息量。** 账号配额耗尽有时只表现为一次连接超时，
因为 provider 或它的 CLI 就只说了这么一句 —— 在真实的 Codex CLI 失败上实测过，它的全部诊断信息就是
`Reconnecting... 2/5 (request timed out)`。解析 message 救不回一个从未被发出的信号，所以路由器退回到
"同一条路由连续失败两次"。

**必须说清楚的局限：** 这只从**第二次请求**开始止血。第一次仍然要等适配器自己报错，而失败码不可能比失败本身更早到达。
要约束第一次的等待时间，只能靠**适配器内部**的超时（对 `dsh-llm-codex` 来说是它 provider 条目里的
`timeoutMs`，默认一次 `codex exec` 十分钟）。

## HTTP API

设置卡片通过以下宿主接口读写配置：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/tier-router/api/models` | 全部 provider 的模型目录（图片能力、推理强度）+ 当前默认模型。 |
| `GET` | `/tier-router/api/config` | 解析后的配置 + 默认值 + 是否可写。 |
| `POST` | `/tier-router/api/config` | 写入单个字段（`{field, value}`）；`value: null` 恢复默认。要求 `content-type: application/json` 且 `Origin`/`Host` 同源，因此你随便访问的网页无法改写路由配置。 |
| `GET` | `/tier-router/api/stats` | 路由计数（`hard`/`normal`/`easy`/`vision`/`visionBridge`/`fallback`/`error`/`routeError`）、按回合计数（`turns`）、最近失败环形缓冲（`errors`）、最近决策环形缓冲（`decisions`）、当前被停用的路由（`benched`）。`error` 指没有任何路由能应答的请求；`routeError` 指单条路由失败，包含被回退链救回来的那些。 |

客户端半边通过这套 API 而不是 settings wire 读写：宿主只向配置类客户端暴露白名单命名空间。

## 依赖要求

- `@deepseek-ai/dsh-llm` `^0.1.5-rc.2` —— adapter 路由与 `contentHasImage`
- `@deepseek-ai/dsh-settings` `^0.1.5-rc.2` —— `installSection`
- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/schemastery` `^3.18.2`
- 客户端半边向 `settings.section` 贡献一项，因此仅在 `platform: web` 下加载。

## 已知限制与兼容性

用之前值得知道：

- **视觉侧车有缓存，但不是免费的。** 只要历史里含图片，每次请求都会调用（或复用缓存调用）视觉模型。
  证据按附件缓存 `visionCacheTtl` 秒（默认 1 小时），过期后同一张历史图片会在下次请求时**重新分析**。
  设 `visionCacheTtl: 0` 可关闭缓存。
- **历史里只要有过图片，后续请求都按含图处理。** 这是有意为之（否则纯文本档位模型会拒绝整段历史），
  且 `replace` 模式下仍由难度档位作答、视觉模型只提供证据。但一个曾经贴过截图的会话，会一直为视觉证据
  付费，直到那一轮离开对话历史。
- **启发式偏保守。** 判定「困难」需要累计得分 ≥ 3；只出现两个硬关键词会落到「一般」。
  可以重设档位，或把 `classifier` 切成 `llm` / `jev`。
- **只有你主动选中它时才会路由。** 它只处理**经由 `smart` 模型**发出的请求，是按会话 opt-in 的。
- **不要和「强制改写模型」的插件同时启用**（例如在 `agent/request` 瀑布里 `await next()` 之后打戳、
  按角色分配 planner/executor 模型的插件）。那类插件优先级高于模型选择器，本插件将永远收不到请求。二选一。
- **依赖是 peer。** `@deepseek-ai/dsh-llm`、`dsh-settings`、`cordis` 来自 DSH 安装本身；
  本包唯一自带的依赖是 `@deepseek-ai/schemastery`。

## 开发

```sh
git clone https://github.com/zhangzhangco/dsh-tier-router
cd dsh-tier-router
npm install --legacy-peer-deps   # 拉取公开的 @deepseek-ai/* peer
npm test                         # 85 个用例，node:test，无测试框架
```

`npm test` 使用 Node 内置测试运行器（`node --test`，自动发现）。注意上游文档里的
`node --test tests/` 在 Node 22.23 上**不可用** —— 它会把目录当成模块路径并抛 `MODULE_NOT_FOUND`。

想在 profile 里跑本地 checkout 而不是已发布包：

```sh
dsh plugin --profile web remove dsh-tier-router
dsh plugin --profile web add link:/绝对路径/dsh-tier-router
```

目录结构：`index.js`（bundle 入口）、`lib/{schema,router,classifier,jev,vision,models-api}.js`、
`lib/types/index.d.ts`（手写 TypeScript 声明）、`client/client.js`（设置卡片，无构建步骤的
`window.__ModuleLoader__` bundle）、`cordis.patch.yml`（bundle 层）、`tests/`。

## 致谢

本项目改编自 [dsh-smart-router](https://github.com/rouyiemei/dsh-smart-router)（MIT）：
路由模型、难度分类器、视觉侧车与设置卡片架构均源于该项目。本次改编重命名了插件、重设了档位默认值、
修正了客户端服务注入，并移除了内置的免费视觉 provider 播种逻辑。

## 许可

[MIT](./LICENSE)。


### 上下文分类

默认仍是 `heuristic`。选择 `llm` 并在 `llmClassifierProvider/Model` 中指定模型，即启用结合任务与步骤上下文的生成式分类；选择 `jev` 则把同一个问题交给 TypeSafe System One，由它回答一道类型化的 `choice`（见下）；升级不会自动切换生产分类器。

有两个确定性情形不交给任何分类器决定，Jev 也不例外：短的延续指令（`继续`、`continue` 等）继承上一轮任务的档位；同一次工具调用出现结构化重复失败时至少为 `hard` —— 这一条是压在判定结果之上的地板，因为升档的全部意义就在于当前这个模型已经失败了。

状态输入排除私有推理及插件快照；工具失败只读 `isError: true`，重复失败要求同工具、同参数及同错误文本重复。`agentStep` 是当前人类回合内的工具调用数，不是模型推理步数。完整消息仍原样交给下游模型。

缓存使用 SHA-256 覆盖完整的有界输入、后端与提示词。相同输入合并并发请求，调用者取消只取消自己的等待；后台工作最长 30 秒且并发上限 32。统计仅在内存保留有限记录，不持久化完整输入。

本地选项评分分类器（`classifier: logits`）已做原型并移除：它的判定会随候选顺序翻转，却仍报告接近满值的信心，这样的分数无法用作闸门。实测记录保留在[决策记录](./benchmarks/RESULTS.md)。

### Jev（TypeSafe System One）

`classifier: jev` 会向 TypeSafe 的托管判断模型提一个 `choice` 问题 ——「下一步交给哪一档」——
拿回选中的档位、每个选项的概率和置信度。整个过程不生成文本，所以不存在「回复格式解析失败」这条
失效路径；路由策略仍然留在代码里。

Key 按以下顺序生效：

1. 在「设置 → Tier Router → Jev」里粘贴（即 `jevApiKey`）；
2. 或导出 `TYPESAFE_API_KEY`；
3. 或沿用本机已装的 TypeSafe SDK 的 `~/.typesafe/key`。

Key 保存在本机设置里，接口**永远不会把它回传给设置卡片**：配置接口只回答「是否已配置」以及
「来自哪里」。也正因为卡片读不到已保存的 Key，输入框永远是空的 —— 留空即不修改，要换 Key
就直接粘贴新的。

本机实测（Apple M4，macOS，到 `api.typesafe.ai`）：一次三选一问题加一个小状态对象，
**端到端 0.73–0.82 秒**（其中建连约 0.2 秒），而预算是 `classifierTimeoutMs` 的 4000 毫秒。
这是一次「回合内容变化」才付一次的代价 —— 判定按有界证据加题目措辞和模型一起缓存，
所以同一回合里的多个工具步骤不会各付一次。

失败处理刻意做得很无聊：没 Key、Key 被拒（401/403）、被限流（429/529）、超时、传输错误、
答复不可用，都会在决策记录里落成一个具名的 `jev-*` 分类器，并把决定权交回启发式。
Key 被拒后还会额外停用 60 秒，所以填错 Key 不会每个回合都白付一次往返。

`jevMinConfidence` 是弃权门槛。三个选项的均匀分布置信度约为 0，因此默认的 `0.3` 挡掉的正是
「没有真实信号、纯靠猜」的判断，而不是让一次抛硬币去选档位。设成 `0` 表示完全信任 Jev 的答案；
调高则意味着更常交给启发式。

评分标准本身（instructions 以及每个选项的 `what` / `not_for` / `examples`）在 `lib/jev.js` 里。
它的措辞是缓存身份的一部分，所以改了措辞绝不会复用按旧措辞做出的判定。
