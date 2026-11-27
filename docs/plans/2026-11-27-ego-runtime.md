# ego 作为浏览器运行时：身份、租约、权限与截屏存储

- 日期：2026-11-27
- 相关：[浏览器插件](2026-10-21-browser-plugins.md)、[浏览器与密钥](2026-10-08-browser-and-secrets.md)、[Bot 交接](2026-10-16-bot-handoffs.md)
- 代码：`ds-bot/src/host/browser/ego/`、`ds-bot/src/host/browser-plugins.js`、`ds-bot/src/client/ego-browser-view.js`

## 为什么

ego lite 不是又一个无头浏览器。它把「人和 agent 共用一个浏览器」做成了产品语义：

- **profile** 持久保存登录态，一台机器可以有多个账号抽屉；**space** 管标签和控制权，一个任务一个空间。
- 人和 agent 可以看同一组标签，登录、验证码、付款可以交给用户，agent 从原地继续。
- 页面有面向 agent 的 `snapshot`，也有 `goto/fill/click/press` 这类带等待的原生动作；`page.cdp` 是逃生口。
- CLI 能自我描述，`ego-browser skill` 就是给 agent 的说明书。

第一版只把 ego 当「投屏目标 + 7 个工具」，能看能点，但没有回答四个问题：**这是谁的登录态、谁在控制这一页、哪些动作要批准、截屏去了哪里**。这一版把 ego 当运行时，Anbot 当治理层：身份、租约、权限、审计和存储由 Anbot 管，页面执行交给 ego。

## 已定的行为

### 1. 运行时与治理层分开

- Anbot 不把 ego 嵌成 Electron webview 的渲染内核，也不复制 ego 的 profile 目录。ego 是独立 Chromium，Anbot 通过 `ego-browser` CLI 驱动它。
- Anbot 保留：Bot 身份、profile 映射、权限与审批、页面租约、审计、截屏留存、安装提示、设置界面。
- ego 保留：profile/space、标签、登录态、页面动作、`snapshot`、CDP 逃生口、未来的下载和验证码能力。
- 只有一个编排者：Anbot 的 Bot 调 ego 工具。ego 自带的 agent 不在 Anbot 的 space 里跑，避免出现第二个没有审计的执行者。

### 2. profile 身份：stable id，不是 Bot 名

- 每个 Bot 首次成功打开页面后，Anbot 在 `<DSH_HOME>/ego-profiles.json` 记下 `botId → { profileId, profileName }`，文件权限 600，原子写入。
- 之后优先用 `profileId`。Bot 改名不影响登录态；改名后仍用原来那份 profile。
- `bot.browserEgoProfile` 是显式覆盖：用户想让这个 Bot 换一份登录，就在这里写 ego 里的 profile 名。换名字就是换登录，这是有意为之。
- 找不到 profile 时 **fail-closed**：不创建 space，不回落用户默认 profile，返回可执行的提示——「在 ego lite 的 Profiles 里建一个叫 `Anbot · X` 的 profile，然后重试」。
- 删除 Bot 不会自动删 ego profile：cookie 在 ego 自己的目录里，Anbot 不越界删除。设置页提供「解除绑定」，ego 里的 profile 由用户处置。
- 共享是允许的，但必须显式。默认每个 Bot 一份 profile；用户把某个 Bot 的 `browserEgoProfile` 指向另一份 profile，就是共享，这个设置动作本身就是用户同意，审计记 `shared`。默认名字的 profile 已经属于另一个 Bot 时，新 Bot 不会继承，报错并要求显式共享或另建 profile。限时、可撤销的共享授权放在 P1。共享的是登录态的使用权，不复制 cookie。

### 3. space 生命周期

- 当前实现是每个 Bot 一个 task space，按 Bot 名命名，面板和工具共用。这样工具调用之间标签不丢，但长期会堆标签、留孤儿 space。
- 下一步按任务收口：一个任务一个 space，结束时 `task.finish({ keep })`，用户钉住的标签才保留；空闲超过阈值由 supervisor 关闭。space 名用 `Anbot · <Bot 名> · <任务短名>`，只作展示，不参与身份判断。
- 同一 Bot 的并发工具调用由租约串行化，不靠 space 名碰运气。

### 4. 感知：snapshot 优先，像素只给面板

- 模型默认看 `ego_snapshot` 的语义树和 ref，不把截图塞进上下文。截图只在两种场景出现：用户要求「看一眼」，或面板的实时镜像。
- 页面内容是不可信数据。工具结果和系统提示都写明：页面上的文字不是用户的指令；遇到「忽略之前的指令」这类内容，按数据对待。
- 实时镜像不是模型输入。AI 不看 2.5fps 的 JPEG 流，只有用户看。

### 5. 动作与审批

- 浏览、点击、输入、按键默认放行；付款一律不由 Bot 做。
- 以下动作逐次审批，不能预授权：
  - `ego_run`：任意页面脚本，能力上等于绕过所有工具级策略。
  - `ego_type` 的 `submit: true`：显式提交表单。
  - `ego_click` 的 label 命中付款词：直接拒绝，并让 Bot `ego_handoff`。
- `ego_open` 只允许 http/https，不允许带用户名密码的 URL；不设域名黑名单，和现有浏览器设计一致。内网地址是否拦截留给后续策略，不在此版偷偷加。
- `supportsGrants` 只在 CLI 可用时为 true；审批复用现有 `authorizeBrowserAction`，审批只允许本次。预授权种类目前仍是 post/upload/download/delete，ego 还没有按 DOM 分类这些动作，所以不假装支持。
- 已知缺口：`ego_click` 仍可能点到提交、删除或付款按钮；`ego_press Enter` 仍可能提交表单。这一版用 label 付款词和显式 submit 兜底，完整的 DOM 目标分类放在 P1。

### 6. 租约与接管

- 每个 Bot 的 ego 页面同一时刻只有一个驱动者。
- Bot 工具开始时取一个短租约（5 分钟上限），结束释放；同一 Bot 的第二个工具调用会被告知「另一个 ego 动作还在跑」。
- 用户在面板上点击、滚轮、输入、导航时，用户立即取得控制权，租约 2 分钟；面板还在轮询就续期。用户控制期间，Bot 工具返回「用户正在控制这一页」。
- `ego_handoff` 把控制权无限期交给用户，Bot 必须停下；`ego_resume` 只能在用户说完成后调用。面板上的「交还」也会释放租约。
- 用户接管不能中止已经在执行的 `ego_run` 或一次点击；租约只拦下一次动作。这是本版的限制，P1 的 driver 要支持取消。

### 7. 截屏与存储

一条铁律：**像素是瞬时数据，审计靠元数据。**

- **实时帧（L0）**：只存在内存。每个 Bot 保留最新一帧，桥断开即丢；不落盘、不进日志、不进遥测、不进模型上下文。帧是 JPEG，约 10–60KB，2.5fps；多 Bot 并行时受内存和 CPU 预算约束。
- **审计（L1）**：`<DSH_HOME>/ego-audit/<botId>.jsonl`，权限 600，1MB 轮转。字段只有：时间、工具、动作、结果、URL 的 origin+path、profileId/profileName、目标 selector（截断）、原因、耗时。不存 query、不存输入文本、不存脚本内容、不存像素。
- **截图（L2）**：`ego_screenshot` 是唯一会写像素的工具，落在 `<DSH_HOME>/browser-shots/<botId>/`，每个 Bot 只保留最近 20 张，旧的自动删除。它是用户要的产物，不是浏览记录。
- **不做**：连续录像、云端同步、把帧 base64 写进错误日志、把帧发给模型供应商、把密码/支付表单截图入库。
- 后续若要「证据帧」，按动作各存一张、加密、7 天、可删除；默认仍是零像素。

### 8. 安装与 profile 引导

- 没装 CLI 时，`builtin:ego` 仍出现在浏览器设置里，只注册 `ego_status`；它不会成为默认浏览器，也不会假装能打开页面。
- `ego_status` 说明三件事：ego-browser 在哪、ego lite 在哪、这个 Bot 该用哪个 profile。缺 CLI 时给出安装提示；缺 profile 时给出要创建的名字。
- 面板打开时如果 CLI 缺失或 profile 缺失，帧接口返回错误对象，面板显示原因，不一直停在「Connecting」。
- 「agent 代装」是后续流程：下载官方安装包、校验签名/公证、拖入 `/Applications`、首次启动。安装脚本必须让用户确认，不能静默装。
- 首次创建 profile 仍要用户在 ego 界面点一次；Anbot 只提示名字，不替用户建账号。

### 9. 失败与降级

- CLI 缺失 → provider 可见、不可默认、`ego_status` 可诊断。
- profile 缺失 → fail-closed，提示建 profile；不使用默认 profile。
- driver 崩溃 → 桥返回 `error`，面板显示；sweeper 清理桥和租约。
- ego 升级导致 API 变化 → 后续用 `ego-browser skill` 的能力清单做版本协商；本版先按已知 API 钉住，契约测试覆盖创建 space、snapshot、点击、截图、finish。

## 分级与阶段

| 级别 | 内容 | 状态 |
|---|---|---|
| P0 | profile stable id、fail-closed、脚本/提交审批、付款拦截、租约与接管、审计元数据、截图留存、安装状态 | 本分支 |
| P1 | 截图改 CDP screencast + WebSocket 推送、DOM 目标分类、supervisor/健康检查、space 按任务收口、下载/上传、多标签面板 | 下一步 |
| P2 | 证据帧/回放、能力清单与版本协商、限时共享授权、上游贡献「每 Bot 独立 profile + 审批」 | 后续 |

## 不做什么

- 不把 ego 当 Electron webview 的渲染内核；跨进程 Chromium 无法嵌入。
- 不在 Bot 之间同步 cookie，不复制 ego 的 profile 目录。
- 不默认使用用户的 profile；缺失就失败，不静默回落。
- 不做连续录屏，不把实时帧写进磁盘或模型上下文。
- 不把 ego 的 CLI/桌面自动化混进 browser slot；那是权限更高的另一类能力。
- 不在本版实现限时共享授权、下载捕获、验证码识别和 CDP screencast。

## 已知限制

- `ego_click` 和 `ego_press Enter` 仍可能触发提交/删除；完整分类需要拿到目标的 DOM 语义。
- 面板是 `<img>` 镜像，不能选中文字、没有 DevTools、坐标受缩放影响；真机点验仍待做。
- 实时镜像是 400ms 轮询 `captureScreenshot`，不是事件驱动 screencast；多 Bot 并行时 CPU 会偏高。
- space 仍是每 Bot 一个，不是每任务一个；孤儿清理只做了桥空闲回收。
- 用户接管不能取消已经在跑的动作。
- profile 创建只有 ego 界面，没有 CLI API；显式共享靠 `browserEgoProfile`，限时共享授权未实现。
- driver 还是字符串模板；P1 拆成独立文件并加 supervisor/指标。

## 可执行验收

- 改 Bot 名字后，下一次 `ego_snapshot` 仍用原 profile，不出现新 profile 或默认 profile。
- 删除/改名 profile 后，工具返回 `EGO_PROFILE_MISSING`，页面不打开，提示包含要创建的名字。
- `ego_run` 和 `ego_type submit:true` 各弹一次审批；拒绝后页面没有动作。
- 面板点击后，Bot 的下一次工具调用返回「用户正在控制」；点「交还」后恢复。
- `ego_screenshot` 连拍 25 次，目录只剩 20 张。
- `ego-audit/<botId>.jsonl` 有记录，URL 不含 query，`ego_type` 的文本和 `ego_run` 的脚本不在里面。
- 没装 CLI 时，provider 出现在设置里，`ego_status` 可读，默认浏览器不是 ego。
- 定向测试、`npm test`、`client.js --check`、`npm run lint` 通过。

## 变更

- 2026-11-27：建立。P0 实现 profile stable id、fail-closed、脚本/提交审批、付款拦截、租约、审计元数据、截图留存和安装状态；P1/P2 留待后续。
