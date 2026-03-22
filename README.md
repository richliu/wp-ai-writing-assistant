# AI Writing Assistant — WordPress Plugin

AI 寫作助手，整合 DeepSeek / OpenAI 相容 API，提供文章校稿、語氣調整、段落級 AI 工具。

## 功能

### 文章側邊欄（Sidebar）
- **整篇校稿**：呼叫 AI 對整篇文章進行校稿
- **選擇語氣**：正式 / 輕鬆口語 / 專業 / 友善親切 / 學術
- **額外指令**：自由填入額外 prompt
- 校稿結果可**套用到文章**或複製

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
| Provider | DeepSeek（預設）、OpenAI、Custom |
| API Key | 填入各平台的 API Key |
| Model | 例如 `deepseek-chat`、`gpt-4o` |
| Max Tokens | 回應最大 token 數（預設 2048）|
| Temperature | 創意程度 0–2（預設 0.7）|
| Custom Endpoint | 使用 OpenAI 相容 API 時填入 |

## 安裝

1. 將整個 `wp-ai-writing-assistant/` 資料夾放入 WordPress 的 `wp-content/plugins/`
2. 在後台「外掛」頁面啟用
3. 前往「設定 → AI 寫作助手」填入 API Key

## DeepSeek API

- 申請：https://platform.deepseek.com/
- 預設 Endpoint：`https://api.deepseek.com/v1/chat/completions`
- 預設模型：`deepseek-chat`

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
