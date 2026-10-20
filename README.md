<div align="center">
  <img src="assets/icon.svg" width="72" alt="dsh-provider-auto icon">
</div>

# dsh-provider-auto（本地补丁版 v0.1.1-patch.2）

> **拥有**：`llm-pi-ai` 配置里"给缺 `reasoningEfforts` 的模型自动补档位"这一件事。
> **口径**：**只认模型 ID**（不看中转 / provider）。一个 ID 一张表项，在任何 provider 下拿到的档位都一样。
> **冲突时**：与任何同样写 `llm-pi-ai` settings 的插件互斥（本机无）；只补 `reasoningEfforts === undefined` 的模型，**绝不覆盖手写声明**。
> **回滚**：`~/.dsh/profiles/<profile>/package.json` 依赖改回 `github:icekale/dsh-provider-auto#v0.1.1` 再 `pnpm install`（备份 `~/.dsh/backups/before-provider-auto-patch-20260930-120742/`）。

上游：`icekale/dsh-provider-auto` v0.1.1（GitHub，MIT）。

## 原版错在哪

原版拿一条**出厂正则**猜谁该有档位，命中就补一套固定值：

```js
modelPattern = /^(?:gpt-5(?:[.-]|$)|o\d(?:[.-]|$)|codex(?:[.-]|$))/i   // 只认 gpt-5 一代
efforts      = { off:null, low:'low', medium:'medium', high:'high' }   // 只补到 high
```

`gpt-6.x` / `claude-*` / `glm-*` / `grok-*` / `deepseek/*` / `xiaomi/*` 全漏 → 每次新增模型都要在 GUI 里手写；而 provider 级配了 `reasoning` 时，缺档位的模型会在**发请求之前**就报 `UNSUPPORTED_REASONING_EFFORT`。

## 补丁版怎么做

一张**扁平的 `模型 ID → 档位` 表**（`efforts.json`），provider 完全不参与匹配：

```
efforts.json
  ├─ 实测   probe-overrides.json   （tools/probe-efforts.mjs 打到本机各线路上采）
  └─ 公开库 rules.json             （OpenRouter ∩ models.dev，1000 条）
      ↑ 合并规则：同名模型跨线路**取交集**（交集对每条线路都合法）
```

运行时命中顺序：

```
efforts.json 按模型 ID（含归一化：`z-ai/glm-5.3-flash` → `glm-5.3-flash`）
   ↓ 未命中
config.modelPattern + config.efforts（profile patch 里的显式兜底）
   ↓ 未命中
不补（宁缺勿错）
```

为什么要取交集：同一个 ID 在不同线路上档位真的不同（实测 `glm-5.3-flash` 智谱官方只有 `low/high/max`、commandcode 给 5 档；`gpt-6-sol` 在 codexx 是 7 档、在 heiheil 是 5 档）。取交集后表里 `glm-5.3-flash` = `low/high/max`、`gpt-6-sol` = 5 档 —— 对每条线路都成立，代价是比最宽的那条少几档。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件本体；导出 `planEfforts()`（纯函数，可离线测）、`resolveEfforts()`、`normModelId()`、`addReasoningEfforts()`（兼容原版签名） |
| `efforts.json` | **主表**：`byModelId[归一化模型 ID] = { efforts, source }` |
| `probe-overrides.json` | 实测原始数据（含 provider 维度，仅供合并用） |
| `rules.json` | 公开库兜底表（含 `byModel` 与来源统计） |
| `tools/probe-efforts.mjs` | 逐 provider 逐模型实测：发一个不存在的档位值，上游把合法值清单吐回来（支持 openai-completions / anthropic-messages） |
| `tools/build-rules.mjs` | 联网拉 OpenRouter + models.dev 取交集 → `rules.json`（`--offline` 用 `.cache/`） |
| `tools/build-efforts-table.mjs` | 合并实测 + 公开库，`同名取交集` → `efforts.json` |
| `tools/selftest.mjs` | 离线自检（16 组断言，不联网不写盘） |

## 命令

```bash
cd ~/.dsh/local-plugins/dsh-provider-auto
node tools/selftest.mjs                  # 离线自检
node tools/probe-efforts.mjs --dry       # 看探测计划
node tools/probe-efforts.mjs             # 真实探测并刷新 probe-overrides.json
node tools/build-rules.mjs               # 刷新公开库表
node tools/build-efforts-table.mjs       # 重算总表 efforts.json（每次改完前两个都要跑这个）
```

## 已知边界

- 表是**某一时刻的快照**；上游换账号池 / 加模型后重跑 `probe-efforts.mjs` + `build-efforts-table.mjs`。
- `rules.json` 只覆盖公开库里有的模型名；私有中转名（`gpt-6-astra` 之类）要么被实测条目覆盖，要么走 `config.modelPattern` 兜底。
- 同名取交集 ⇒ 表里的档位**偏保守**（比最宽线路少几档）。想要精确，就在对应 provider 下把该模型实测一遍并接受它是"该 ID 的全局口径"。
- 上游"不校验档位"的线路（grok / claude 中转）采不到实测，条目来自公开库 —— 传错不报错，但也不保证生效。
- 本插件不 import `@deepseek-ai/schemastery`（本地 link 场景下从 realpath 向上找不到），因此不导出 `Config` schema；配置由 profile patch 的 `config` 原样传给 `apply(ctx, config)`，缺省值在 `index.js` 的 `DEFAULTS` 里。

---

## ☕ 赞赏支持

如果 dsh-provider-auto 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
