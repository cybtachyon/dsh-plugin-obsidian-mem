# Obsidian Mem

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的智能体（Agent）的共享记忆系统，
基于纯 Markdown 知识库（Vaults）构建。

Obsidian Mem 可将您的 Obsidian 风格知识库转化为顺畅、可由人工编辑的工作维基（Wiki），
供每个智能体会话读取与写入。

OM 引入了基于检索增强生成（RAG）的召回机制，其向量搜索由 Milvus-Lite 数据库驱动。

使用 Obsidian + Git 等 Markdown 工具打开、编辑和同步您的笔记，
并观察您的智能体如何从共享经验中学习。

## 安装

命令行方式：
```bash
# 安装最新版 NPM 包
dsh plugin --profile web add dsh-plugin-obsidian-mem
```
```bash
# 从源码安装
dsh plugin --profile web add https://github.com/cybtachyon/dsh-plugin-obsidian-mem
```

若从本地源码仓库安装，请先运行 `pnpm build`：该命令会执行工作区类型检查（`tsc -b`），
并通过 `node scripts/build-client.mjs` 使用 esbuild 生成 `dsh/client.js` 浏览器卡片构件。

Web UI 方式：点击“插件”（Plugins）→“添加插件”（Add Plugin）→ 粘贴 `dsh-plugin-obsidian-mem`。

或者，您也可以直接从 DSH 插件市场（DSH Plugin Marketplace）安装。

## 功能特性

- **自动 RAG 召回：** 通过生命周期钩子（Lifecycle hooks），在对话轮次开始时自动注入相关笔记。
  当智能体遇到高度相关的文件或特定的“思考关键词”时，相应的上下文也会被注入（注入量设有合理上限）。
  在对话轮次结束时，系统会提醒智能体哪些内容值得保存。
- **五种智能体工具：**
  - `memory_read`：根据路径从知识库中读取笔记。
  - `memory_search`：跨全部知识库进行向量与关键词相结合的混合检索。
  - `memory_write`：保存笔记（仅限共享知识库）。
  - `memory_audit`：报告知识库大小、索引状态，并在超出容量限制时发出警告。
  - `memory_dream`：执行“拆分与压缩”（split-compaction）流程，对笔记进行合并与精简。
- **开箱即用。** 无论您拥有几十个知识库（Vault），还是仅需共享一两条 `AGENTS.md` 中的条目，
  都可以灵活配置属于您自己的共享知识库。当然，您也可以直接使用默认的共享知识库：`$HOME/.dsh/obsidian-mem/`！
- **知识库权限。** 您可以将 Markdown 知识库设置为“只读”（Agent 仅可查询，不可写入），
  也可以通过“采纳与共享”（Adopt and Share）模式实现协作（Agent 既可读取也可写入）。
- **可配置选项。** 通过 Web GUI 中的“Obsidian Mem”卡片，您可以管理知识库列表及文件偏好设置。
  您可以调整搜索参数，并设定按计划自动执行的“构思”（Dreaming）。
  此外，您甚至可以在 DSH Creator 模式下，直接让 Agent 帮您完成这些配置！
- **全局记忆文件。** 知识库支持可配置、可编辑的全局记忆文件。
  该文件会在会话启动时加载，并计入全局记忆容量预算。

## 为什么还要开发另一个 Agent 记忆项目？

在现有的众多同类项目中（我尽可能多地调研了市面上的方案），没有一个能够同时满足以下需求：
- 支持我按需添加任意数量的 Markdown / Obsidian 知识库；
- 支持随时随地添加；
- 支持高度可定制的组织结构；
- 并且具备向量搜索及维护功能。

我希望能够与我的 Agent 共享项目笔记，并让知识库的维护成果成为人类与自动化系统共同整理知识的结晶。

## 存储结构

所有 `*.md` 文件均会被索引，但以下情况除外：以点（`.`）开头的目录和文件一律不会被索引；
此外，知识库根目录下的以下路径由本插件保留使用：

| 知识库路径 | 描述 |
| :--- | :--- |
| `<vault>/.<slug>_history.md` | 在“构思”（Dreaming）中归档退役的笔记历史；该后缀为保留后缀。 |
| `<vault>/.INTENTS.md` | Agent 意图文件，定义了触发记忆调用的短语。 |
| `<vault>/.obsidian-mem/metadata/` | 包含索引器状态文件以及“构思”日记文件 `DREAMS.md`。 |

| 插件路径 | 描述                                            |
| ------------------------------------ | ----------------------------------------------------------- |
| `$HOME/.dsh/obsidian-mem/`           | 默认共享知识库（尚未添加任何知识库时会自动创建）。 |
| `$HOME/.dsh/obsidian-mem-db/`        | 用于记忆搜索的 Milvus-Lite 数据库（可按需重建，可安全删除）。 |
| `$HOME/.dsh/obsidian-mem-db/models/` | 记忆搜索所用的 ONNX 模型缓存。 |

## 配置

您可在 DSH 插件的配置界面中找到相关设置：

| 参数             | 默认值                         | 说明                                                                                                                                       |
|------------------|--------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `vaults[]`       | `$HOME/.dsh/obsidian-mem/`     | 每个知识库包含：`path`（路径）、`mode`（模式：`shared` 或 `readonly`）、`globalFile`（相对于知识库根目录的路径；留空则默认为 `GLOBAL.md`） |
| `vectorDim`      | `384`                          | e5-small 的完整维度；设为 `128`–`320` 会导致信息损失；若修改此值，需重新建立索引。                                                         |
| `embeddingModel` | `Xenova/multilingual-e5-small` | ONNX q8 量化版本；使用 `passage:` / `query:` 前缀。                                                                                        |
| `modelCacheDir`         | `$HOME/.dsh/obsidian-mem-db/models`  | transformers.js 的 `env.cacheDir`                                   |
| `dbDir`                 | `$HOME/.dsh/obsidian-mem-db`         | Milvus-Lite 数据目录                                       |
| `keywordLlm`            | off                                  | 可选的兼容 OpenAI 接口的端点，用于增强启发式唤醒关键词提取功能 |
| `recallBudget`          | 按计划（per plan）                   | 限制每轮对话注入的召回上下文数量                            |

## 技术背景

该插件按需管理其自身的向量数据库：
1. 确保具备 `uv`/`uvx` 工具链（若缺失，则自动安装 `uv`）
2. 启动一个绑定至本地端口的 `milvus-lite` 服务器，数据存储于
   `$HOME/.dsh/obsidian-mem-db/` 目录下

无需用户手动安装 Python 或 Milvus，也无需配置外部 Milvus 实例。

RAG（检索增强生成）采用混合搜索模式，结合了基于本地 ONNX 模型的稠密向量搜索（HNSW/余弦相似度）与稀疏 BM25 搜索。文本分块（`chunk_text`）存储时不包含嵌入前缀，并启用分析器（`enable_analyzer`）。

## 模型下载与离线使用

该插件会将 `Xenova/multilingual-e5-small`（ONNX q8 格式，约 135 MB）下载至
`$HOME/.dsh/obsidian-mem-db/models` 目录。
若需在离线环境中使用，可先在联网机器上预加载缓存：

```
node scripts/prefetch-model.mjs
```

## 开发

使用 `pnpm` 进行构建、测试和代码检查（lint）；架构说明及验证命令请参阅 [AGENTS.md](../../AGENTS.md)。

- `pnpm test` 完全在离线环境下运行；另一层集成测试
  （位于 `packages/service/tests/integration/*.live.test.ts`）仅在执行 `RUN_LIVE=1 pnpm test` 时才会运行。
- “实时”（Live）层会启动一个由 `uvx` 管理的真实 `milvus-lite` 实例（首次运行时需下载，可能耗时数分钟）。
- “实时”层会从本地缓存加载真实的 `Xenova/multilingual-e5-small` 模型，并驱动整个流程：资源配置 → 索引构建 → 混合搜索 → 直写（write-through） → 数据清理。
- 每个测试用例均设有 180 秒的宽裕超时时间，以应对缓存尚未预热（cold cache）的情况。
- 所有写入的数据均存放在临时目录中；仅模型缓存会被复用。

运行方式：

```
RUN_LIVE=1 pnpm test
```

## 参考资料与前人工作

- 优秀的 [Tinqiao Engramory](https://github.com/tinqiao-oss/engramory/)：为本项目大部分 Markdown 系统设计与记忆管理设计提供了灵感。
- [Zilliz Memsearch](https://github.com/zilliztech/memsearch)：涉及 Milvus 搜索与重排序（reranking）。
- [bufan528 Memory Vault](https://github.com/bufan528/dsh-longterm-memory)：涉及召回预算（recall budgeting）、元数据及提取机制的设计。
- 此外还参考了大量的 DSH Markdown、RAG 及记忆插件；其中多数构思非常有趣，虽未直接提供可用的实现素材，但看到社区不断创新并尝试各种方案，依然令人欣喜。同时，我也借此明确了哪些方案并不符合我的需求或偏好。
