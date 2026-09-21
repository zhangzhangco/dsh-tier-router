# 本地开发与发布

这份文档描述**在一台已经跑着 dsh web 的机器上**改这个插件的完整环路：
改代码 → 测试 → 让运行中的实例加载新代码 → 发布。

## 一、本机布局

```
<repo>/                        ← 你 clone 的这棵 checkout，唯一的代码真相
~/.dsh/profiles/<profile>/     ← dsh 的 profile
  package.json                 ← 依赖里应是 link:<repo>
  node_modules/dsh-tier-router → 符号链接到 <repo>
```

把 profile 指到本地 checkout（只需做一次）：

```sh
dsh plugin --profile web add link:"$PWD"
```

检查是否指对了：

```sh
node -p "require(process.env.HOME + '/.dsh/profiles/web/package.json').dependencies['dsh-tier-router']"
# => link:/path/to/this/repo
```

想切回 npm 上的正式版本：

```sh
dsh plugin --profile web add dsh-tier-router@0.5.0
```

> **0.x 的 caret 陷阱**：`^0.2.1` 只允许 `>=0.2.1 <0.3.0`，**永远升不到 0.3.0 以上**。
> 0.x 阶段每次升级都得写明确版本号。

## 二、日常环路

```sh
npm test                 # 166 个用例，纯 node --test，无构建步骤
scripts/dev-restart.sh   # 重启 dsh web，让它加载当前 checkout
```

`scripts/dev-restart.sh` 做的事：确认 profile 指向本 checkout → 停掉占用端口的旧进程
→ 清理被 kill 留下的 `*.lock`（不清会让新进程卡在 writer lock 超时）→ nohup 拉起新进程
→ 轮询健康检查 → **校验线上跑的确实是这棵 checkout 的代码**。

最后一步的校验方式与版本号无关：它把本机 `lib/schema.js` 里 `SETTINGS_SCHEMA` 的键
和线上 `GET /tier-router/api/config` 返回的键对比。本地 schema 若新增了设置项而线上
没有，就说明进程读的还是旧代码。因此改完设置项后重启，这个检查会立刻给你结论。

常用变体：

```sh
scripts/dev-restart.sh --check       # 只校验，不重启
scripts/dev-restart.sh --delay 45    # 延迟 45 秒（让当前这一轮回复先送达）
PORT=8080 scripts/dev-restart.sh     # 换端口
DSH_BIN=/path/to/dsh scripts/dev-restart.sh
```

`--check` 是安全的自检：它只做 profile 链接检查和上面那项「线上是不是这棵 checkout」的
比对，不碰进程。改完代码想知道"要不要重启"，先跑它：

```
$ scripts/dev-restart.sh --check
   package.json 声明 : link:/path/to/repo
   profile 实际解析到: 0.5.0
   ✓ 0.5.0
   本地 schema 键 27 个，线上 24 个
   ✗ 线上缺少本地新增的键: hardScore, routeCooldownMs, routeFailureThreshold
     进程读的还是旧代码（或插件未加载）。日志: ~/.dsh/web-web.log
   → 需要重启：跑 scripts/dev-restart.sh（不加 --check）
```

退出码：`0` = 线上已是这棵 checkout 的代码；`1` = 需要重启（或校验失败）。

**为什么必须重启**：dsh 用 Node 的模块缓存加载插件，改 `lib/*.js` 后进程不会重新读盘。
cordis 的 `patchReload: live` 只覆盖 `cordis.patch.yml` 这类配置变更，覆盖不到插件自身
的实现文件。（`client/client.js` 是另一回事：Web 端 HMR 在 `pnpm run dev:web` 运行时
能热更新，但服务端半部分仍然要重启。）

## 三、发布

```sh
# 1. 先把 CHANGELOG.md 的条目写好（标题形如 ## [0.5.1] - 2026-09-21）
# 2. 发布
scripts/release.sh 0.5.1
```

脚本按七步走，任何一步失败都会停下，不会发出半成品：

1. 前置检查：在 `main` 上；除 `CHANGELOG.md` / `package.json` 外无未提交改动；
   CHANGELOG 有目标版本条目；`v<版本>` tag 未被占用；npm 上尚无该版本
2. `npm test`（**失败即中止**）
3. 把 `package.json` 的 version 定为目标版本
4. 提交 + 打注释 tag
5. `git push origin main --follow-tags`
6. `npm publish --access public`
7. 轮询 registry 确认版本真的上线，并打印 `dist-tags`

其它开关：

```sh
scripts/release.sh patch              # 0.5.0 -> 0.5.1（也支持 minor / major）
scripts/release.sh 0.6.0 --dry-run    # 只检查 + 跑测试，不写盘、不提交、不推送
scripts/release.sh 0.6.0 --skip-npm   # 只推 GitHub
scripts/release.sh 0.6.0 --skip-tests # 跳过测试（不推荐）
```

> `--dry-run` 是真正无副作用的：它不会改 `package.json`，也不会创建 commit 或 tag。

### npm 凭据

脚本按 `$NPM_TOKEN` → `~/.npm-publish-token` → `~/.npmrc` 的顺序找第一个能用的 token，
先 `npm whoami` 验活再发布。`~/.npm-publish-token` 里可以是裸 token，也可以带
`_authToken=` 前缀。

**在 npm 官网的「网页登录」不会给 CLI 写凭据** —— 它只建立浏览器会话。CLI 侧要么
`npm login`（浏览器授权，token 落到 `~/.npmrc`），要么在 npmjs.com 建 Automation token
写进 `~/.npm-publish-token`。

失败时的表现：`npm publish` 可能报 `E404 Not Found - PUT .../dsh-tier-router`，看起来像
包不存在，实际是**认证失败**（npm 对无权限的包返回 404 而非 403）。看到 E404 先查凭据。

## 四、两个容易踩的点

**1. 运行时依赖是双副本，这是安全的。**

插件的 `@deepseek-ai/dsh-llm` 解析到本仓库自己的 `node_modules`，而 dsh 运行时用
npx checkout 里的那一份，两份是**不同的模块实例**。这不会出问题，因为：

- 注册适配器走的是鸭子类型 —— `dsh-llm` 的 `prepareRoutes()` 只调用
  `adapter.providerInfo()` / `adapter.providerRetryPolicy()`，全仓**没有任何
  `instanceof LlmAdapter` 校验**；
- 两份的版本一致（`dsh-llm 0.1.5-rc.2`、`schemastery 3.18.2`）。

若要绝对排除漂移，可以让 `node_modules/@deepseek-ai` 指向运行时的副本；但那样每次
`npm install` 都会被覆盖，反而更脆。**保持 npm 装、保持版本一致即可。**

**2. profile 里其它插件的 peer 警告是既有的。**

`pnpm peers check` 会报 `@deepseek-ai/cordis` / `dsh-llm` 等 peer 缺失 —— 因为 profile
设了 `autoInstallPeers: false`，peer 由运行时的 npx checkout 提供。这是设计如此，不是
本地 checkout 引入的回归。
