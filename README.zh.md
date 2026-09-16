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

- **三级难度路由** —— 启发式分类器（默认：零成本、零延迟、结果确定）或可选的 LLM 分类器（带缓存）。
- **视觉侧车（vision sidecar）** —— 请求含图片时，先由视觉模型把图片转成结构化证据
  （摘要 / OCR / 版面），以文本替换原图片块，再由难度档位作答；也保留 `route` 旧模式，把整轮交给视觉档。
- **阶梯回退** —— 目标档位 → 其余档位（困难优先）→ 你的默认模型。
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

## 快速开始

1. 打开 Web GUI →「设置 → Tier Router」，为四个档位各选一个 provider + model。
   下拉列表来自你已配置的全部模型，并标注 `✓ Vision` 与推理强度。
2. 在聊天输入框的模型选择器里选择 **Tier Router（自动路由）**。
3. 正常发消息即可。路由计数与最近失败在同一设置页。

> 本仓库内的默认值指向作者自己的本地路由（`codex-local`、`gpudev`）。请把四个档位改成你自己的模型。
> 留空的档位会被自动跳过并回退，不会让请求失败。

## 配置项

设置位于 `tier-router` 命名空间，全部为扁平字段。可在设置卡片中编辑，也可直接写 YAML：

```yaml
tier-router:
  enabled: true
  classifier: heuristic          # heuristic | llm
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
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关闭后请求走会话默认模型。 |
| `classifier` | `heuristic` | `heuristic`（内置打分）或 `llm`（由模型判定档位）。 |
| `hardProvider` / `hardModel` / `hardEffort` | `codex-local` / `gpt-6-astra` / `''` | 困难档。 |
| `normalProvider` / `normalModel` / `normalEffort` | `codex-local` / `gpt-5.5` / `''` | 一般档。 |
| `easyProvider` / `easyModel` / `easyEffort` | `gpudev` / `qwen3.8-27b-q5` / `''` | 简单档。 |
| `visionProvider` / `visionModel` / `visionEffort` | `codex-local` / `gpt-6-astra` / `''` | 视觉档。 |
| `visionMode` | `replace` | 视觉处理方式，见下文。 |
| `visionCacheTtl` | `3600` | 视觉证据缓存秒数。 |
| `visionFallbacks` | `[]` | 视觉档失败后、默认模型之前的显式回退。 |
| `fallbackProvider` / `fallbackModel` | `''` | 所有档位都未配置时使用的路由；空 = 会话默认模型。 |
| `llmClassifierProvider` / `llmClassifierModel` | `''` | `classifier: llm` 时使用的分类模型。 |

## 路由规则

```
请求 ──► 含图片?
          ├─ 是 ─► visionMode=replace: 图片 → 视觉模型 → 结构化证据文本 ─┐
          │        visionMode=route:   整轮 → 视觉档                    │
          └─ 否 ───────────────────────────────────────────────────────┤
                                                                        ▼
                                        难度分类（启发式 / LLM）──► 档位链
                                        选中档 → 其它档（困难优先）→ 默认模型
```

**难度信号**为中英双语：代码块体积、文件引用数量、消息长度，以及 *架构 / 重构 / 并发 / 死锁 /
内存泄漏 / 分布式 / 迁移 / 性能 / 安全 / architecture / refactor / distributed / deadlock…* 等关键词。
累计得分 **≥ 3** 判为「困难」；含任务动词的消息至少为「一般」；寒暄、翻译、简短解释为「简单」。

有两个行为值得了解：

- **图片历史也算含图。** 请求携带完整会话历史，因此只要有**任一**历史消息含图片，整个请求就按含图处理
  —— 否则纯文本档位模型会以「does not support image input」拒绝整段历史。
- **`visionMode`。** `replace`（默认）让视觉模型只做辅助：它返回结构化证据，证据文本替换图片，
  最终由难度档位作答。`route` 是旧行为：整轮直接交给视觉档。

## HTTP API

设置卡片通过以下宿主接口读写配置：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/tier-router/api/models` | 全部 provider 的模型目录（图片能力、推理强度）+ 当前默认模型。 |
| `GET` | `/tier-router/api/config` | 解析后的配置 + 默认值 + 是否可写。 |
| `POST` | `/tier-router/api/config` | 写入单个字段（`{field, value}`）；`value: null` 恢复默认。 |
| `GET` | `/tier-router/api/stats` | 路由计数与最近失败。 |

客户端半边通过这套 API 而不是 settings wire 读写：宿主只向配置类客户端暴露白名单命名空间。

## 依赖要求

- `@deepseek-ai/dsh-llm` `^0.1.5-rc.2` —— adapter 路由与 `contentHasImage`
- `@deepseek-ai/dsh-settings` `^0.1.5-rc.2` —— `installSection`
- `@deepseek-ai/cordis` `^4.0.2`
- `@deepseek-ai/schemastery` `^3.18.2`
- 客户端半边向 `settings.section` 贡献一项，因此仅在 `platform: web` 下加载。

## 致谢

本项目改编自 [dsh-smart-router](https://github.com/rouyiemei/dsh-smart-router)（MIT）：
路由模型、难度分类器、视觉侧车与设置卡片架构均源于该项目。本次改编重命名了插件、重设了档位默认值、
修正了客户端服务注入，并移除了内置的免费视觉 provider 播种逻辑。

## 许可

[MIT](./LICENSE)。
