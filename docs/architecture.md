# 代码结构与维护指南

## 加载与依赖

扩展保留免构建的原生 JavaScript 结构，没有新增运行依赖。

后台使用经典 service worker：`background.js` 先同步 `importScripts(...)`，再注册 Chrome 事件。依赖文件只定义常量、状态和函数，不自行注册消息监听器。worker 被回收后，内存集合会重建，持久会话通过 `background-session.js` 恢复。

页面脚本按 `manifest.json` 顺序共享扩展隔离世界。先加载扫描、布局、状态及功能函数，最后由 `content.js` 探测旧运行时并启动。不得在功能文件顶层调用尚未加载的依赖或启动定时器。`page-navigation-guard.js` 单独运行在 MAIN 世界，只通过既有 DOM 事件协作，不能直接访问 `JC_STATE`。

弹窗保持 ES module；`popup.js` 静态导入 `popup-resume.js`，只有解析 PDF 才动态加载 PDF.js。Word、Markdown 和纯文本读取不需要 PDF 库。

这些文件属于按职责拆分的经典脚本，并非完全隔离的 ES module。共享函数名仍需唯一，改变加载顺序必须运行加载测试。避免同时进行模块体系迁移和自动投递状态机重写，以便定位回归。

## 后台职责

| 文件 | 职责 |
| --- | --- |
| `background-state.js` | 默认配置、schema、时序常量和内存集合 |
| `background-session.js` | 会话和日志存储、快照裁剪、所属标签信息 |
| `background-browser.js` | Chrome 回调转 Promise；统一读取并传播 `lastError` |
| `background-contact.js` | 原生点击、鼠标释放、聊天伴随标签 |
| `background-navigation.js` | 暂停与恢复、空闲保护、职位页路由边界 |
| `background-analysis.js` | 读取设置、选择简历、组织一次岗位分析及有限重试 |
| `background-ai-chat.js` | 请求与正文超时、Chat Completions 及兼容回退 |
| `background-ai-providers.js` | Anthropic、Responses、Gemini 协议适配 |
| `background-ai-endpoints.js` | URL、认证、协议和正文格式归一化 |
| `background-ai-usage.js` | token 口径转换和多请求汇总 |
| `background-ai-prompt.js` | 输入预算和评分提示词 |
| `background-ai-json.js` | 本地 JSON 修复、结构校验和结果归一化 |

`fetchAiResponse` 返回 `{ ok, status, text }`，其中 `text` 已读取完成。它不是原始 `Response`，协议适配器不能再次调用 `.text()`。一个请求的 60 秒超时覆盖响应头与正文；协议回退或空正文重试仍是各自独立的请求。

## 页面职责

| 文件 | 职责 |
| --- | --- |
| `content-state.js` | `JC_STATE`、页面代次、运行标记、计时状态 |
| `content-job-scan.js` | DOM 到岗位记录、薪资与标题提取 |
| `content-panel-layout.js` | 面板拖动、缩放和位置存储 |
| `content-panel.js` | 面板 DOM 创建和事件绑定 |
| `content-session.js` | 设置同步、所属会话恢复与远端状态展示 |
| `content-controls.js` | 用户操作、暂停与继续、开关持久化 |
| `content-analysis.js` | 串行分析循环、重试选择和分析失败处理 |
| `content-pipeline.js` | 批次、冷却、队列及会话快照 |
| `content-page-context.js` | 列表变化观察、快照合并、旧状态清理 |
| `content-job-list.js` | 增量渲染、事件委托、关闭和单岗位重试 |
| `content-ai-feedback.js` | 错误分类、诊断文案和岗位定位 |
| `content-auto-contact.js` | 自动沟通状态转换和在途标记 |
| `content-manual-contact.js` | 手动可信点击、聊天入口和运行时探测 |
| `content-contact.js` | 点击送达、详情选择、后台限速处理 |
| `content-contact-evidence.js` | 岗位身份匹配、确认窗口、成功证据与分析日志 |
| `content.js` | 最终启动、消息桥、公共页面辅助函数 |

## 必须保持的行为约束

- API Key 和简历正文不进入公开的页面运行设置；后台只返回白名单字段。
- 分析结果必须同时匹配当前运行编号与页面代次，避免换页后的旧请求覆盖新岗位。
- 原生沟通前必须成功保存岗位在途标记；保存失败不能继续点击。
- 点击送达后才开始完整的确认窗口；超时或异常时仍需清除在途状态、释放鼠标及调试连接。
- 已有“继续沟通”文案和相同公司名均不能单独证明当前岗位投递成功。
- 手动暂停不能被机器恢复事件撤销；单岗位重试结束后不能擅自推进下一批。
- 保留现有 3 秒沟通前等待、5 秒岗位间隔、15 个岗位批次及 60 秒冷却。
- 已处理键、脱离 DOM 的岗位和持久化分析均有上限；不要重新引入无界历史或完整页面高频扫描。

## 注释与规模约定

第一方业务注释使用中文，重点解释原因、状态约束、时序和兼容边界，不重复代码字面含义。协议依据链接保留，更新适配行为时再核对对应文档。第三方库和历史发布说明不作批量风格修改。

文件以约 300 行为整理信号。目前超过该值的 `background-ai-json.js`、`content-analysis.js`、`content-contact.js`、`content-job-list.js`、`content-job-scan.js`、`content-manual-contact.js` 和 `content-pipeline.js` 保留同一职责内的修复、队列或交互链，避免为了行数再增加跨文件追踪。`popup.js` 集中装配表单、默认值和监听器，`content.css` 是单一面板样式表，按入口装配和样式表例外处理。

`analyzeJobs`、`analyzeJob`、`advanceToNextBatch` 等较长流程函数保留其连续控制路径，因为暂停、代次失效、重试和清理路径需要一起审查。新增功能优先提取纯计算或边界适配，不再向主循环堆叠独立职责。面板模板、选择器映射和 schema 可作为声明性内容保留。

## 检查与交付

```bash
node scripts/check.js
node --test "tests/*.test.js"
node scripts/stage-extension.js
```

- `tests/helpers/extension-source.js` 从真实入口展开源码，供既有结构断言及 VM 单元测试使用。
- `runtime-loading.test.js` 逐文件执行经典脚本，防止“拼接后能运行、真实加载却失败”。页面测试替换 DOM 启动动作，不模拟完整网站。
- `ai-response-body-timeout.test.js` 覆盖响应正文卡住、错误状态返回和定时器清理。
- `popup-runtime.test.js` 覆盖保存失败、分数线边界和无需 PDF 的文本导入。
- `runtime-package.test.js` 使用临时目录验证安装资源齐全且不包含开发文件。
- 发布工作流使用相同的检查与整理脚本；仅修改本地工作流不会发布任何版本。

自动测试不等于真实网站验证。Chrome/Edge 权限确认、PDF worker、实际 BOSS 页面选择器和原生沟通需要浏览器验收；进行真实沟通前应使用人工选择的测试岗位。

## 文件注释覆盖与配置说明

逐文件检查覆盖所有纳入 Git 的第一方 JavaScript、HTML、CSS 和工作流：运行代码说明职责与约束，测试文件说明验证目标，页面夹具说明模拟场景。忽略的浏览器快照和本地产物不属于源代码，第三方 `vendor/` 保留原有版权及说明，Markdown 和许可证直接保留正文。

`manifest.json` 使用标准 JSON，不能加入注释。字段职责如下：

| 字段 | 用途 |
| --- | --- |
| `manifest_version` / `version` | 扩展规范版本与发布版本号 |
| `permissions.storage` | 保存用户配置和运行会话 |
| `permissions.tabs` | 定位所属职位标签与聊天标签 |
| `permissions.idle` | 监听机器锁定与恢复，保护自动投递状态 |
| `permissions.debugger` | 通过浏览器原生输入派发沟通点击 |
| `host_permissions` | 声明职位网站与默认 AI 接口访问范围 |
| `optional_host_permissions` | 用户保存自定义接口时按域名申请访问权限 |
| `action.default_popup` | 扩展工具栏设置页面 |
| `background.service_worker` | 后台事件入口；在文件内显式加载依赖 |
| `content_scripts` | 声明页面匹配、脚本加载顺序、执行时间和 MAIN/隔离世界边界 |

`.gitignore` 排除凭证、浏览器用户数据、测试快照和 `dist/` 安装产物，避免本地生成文件随源码提交。
