# AI Writing Assistant — WordPress Plugin

專為個人用戶設計的簡單版本 AI 寫作助手，整合 DeepSeek / OpenAI 相容 API / Claude API，提供文章校稿、語氣調整、段落級 AI 工具。
沒有廣告，沒有 PRO ，無需其它帳號，只需要 AI API Key 即可

目前僅測過 deepseek，預設模型 `deepseek-flash`（V4.1 Flash，1M tokens context），一律以非思考模式呼叫

## 功能

### 文章側邊欄（Sidebar）
- **整篇校稿**：呼叫 AI 對整篇文章進行校稿
- **選擇語氣**：正式 / 輕鬆口語 / 專業 / 友善親切 / 學術
- **額外指令**：自由填入額外 prompt
- 校稿結果可**套用到文章**或複製
- **AI 分析文章**：建議標題、英文連結（slug，取英文關鍵字而非逐字翻譯）、標籤、分類，並產生摘要（摘要 prompt 要求盡量不放超連結，避免連結多的文章摘要充滿連結）
  - 「一鍵更新頂部＋摘要」：同時寫入文章頂部段落與文章摘要（excerpt）；頂部段落帶 `ai-summary` class，重跑會更新同一段而不會重複插入

### 段落工具列
- 每個**段落、標題、引用**區塊的工具列出現「AI 段落工具」下拉選單
- 從所有已設定的 Prompt 中選一個，直接改寫該段落

### Prompt 管理（設定頁面）
- 內建預設 Prompt：校稿、改正式語氣、改輕鬆語氣、摘要、展開段落
- **預設 Prompt 不可刪除**，確保永遠有備選
- 可自由新增 / 編輯 / 刪除 Prompt

### API 設定
| 欄位 | 說明 |
|---|---|
| Provider | DeepSeek（預設）、OpenAI、Claude（Anthropic）、Custom |
| API Key | 填入各平台的 API Key |
| Model | 例如 `deepseek-flash`、`deepseek-v4-pro`、`gpt-4o`、`claude-opus-5-5` |
| Max Tokens | 回應 token 數上限（預設 32768）；實際值依輸入長度自動計算，輸出被截斷時報錯不套用 |
| Temperature | 創意程度 0–2（預設 0.7）；Claude 新模型不支援，不會送出 |
| Custom Endpoint | 使用 OpenAI 相容 API 時填入 |

## 安裝

1. 將整個 `wp-ai-writing-assistant/` 資料夾放入 WordPress 的 `wp-content/plugins/`
2. 在後台「外掛」頁面啟用
3. 前往「設定 → AI 寫作助手」填入 API Key

## DeepSeek API

- 申請：https://platform.deepseek.com/
- 預設 Endpoint：`https://api.deepseek.com/v1/chat/completions`
- 預設模型：`deepseek-flash`（`deepseek-chat` / `deepseek-reasoner` 為官方宣布停用的舊別名）

## Claude API

- 申請：https://console.anthropic.com/
- Endpoint：`https://api.anthropic.com/v1/messages`（Messages API，`x-api-key` + `anthropic-version: 2023-06-01`）
- 模型：`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`
- Claude 5 系列無法關閉思考，外掛固定送 `output_config.effort: low` 降低延遲與 token；不送 `temperature`
- `stop_reason: max_tokens` 視為截斷報錯；`refusal` 會回報錯誤

## 目錄結構

```
wp-ai-writing-assistant/
├── wp-ai-writing-assistant.php   # 主程式，載入所有模組
├── includes/
│   ├── class-settings.php        # API 設定 CRUD
│   ├── class-prompts-manager.php # Prompt 管理 CRUD
│   └── class-api-handler.php     # AI API 代理（REST endpoint）
├── admin/
│   └── settings-page.php         # 設定頁面 HTML
└── assets/
    ├── js/
    │   ├── editor-sidebar.js     # Gutenberg 側邊欄
    │   ├── paragraph-tools.js    # 段落工具列
    │   └── admin-settings.js     # 設定頁 JS (jQuery)
    └── css/
        ├── editor.css            # 區塊編輯器樣式
        └── admin.css             # 設定頁樣式
```
