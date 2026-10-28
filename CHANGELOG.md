# Changelog

## 1.7.1
- **Docs:** README 更正為已測試 DeepSeek 與 Claude API

## 1.7.0
- **Feat:** 新增 Claude（Anthropic）provider：Messages API（`/v1/messages`），模型 `claude-opus-5-5` / `claude-sonnet-5-5` / `claude-haiku-5-5`
  - 不送 `temperature`（新模型會回 400）；Claude 5 系列固定 `output_config.effort: low`
  - 解析 `content` 中的 text blocks；`stop_reason` 為 `max_tokens` 時報截斷、`refusal` 時報錯
- **Feat:** AI 摘要新增「一鍵更新頂部＋摘要」，同時寫入文章頂部段落與 excerpt；另有「只更新文章頂部」/「只設為文章摘要」
  - 頂部摘要段落帶 `ai-summary` class，再次執行會更新該段，不再重複插入
  - 寫入頂部或摘要後，側邊欄的 AI 摘要保留不清除，只有按「捨棄」才會移除
- **Feat:** AI 分析文章新增「建議英文連結（slug）」：取 3~5 個英文關鍵字（不逐字翻譯中文標題），可直接編輯，勾選後隨「套用選取的建議」寫入文章網址
  - 已發佈文章預設不勾選並提示（改網址會讓舊連結失效）；前後端都會正規化為小寫 `a-z0-9-`
- **Change:** 摘要 prompt 不再附加「保留所有超連結」，改為要求聚焦重點、盡量不放連結（除非理解重點不可或缺，最多一個），避免連結多的文章產生滿是連結的摘要；不會強制移除 AI 給的連結
- **Fix:** 設定頁表單有未儲存的修改時，「測試連線」改為提示先儲存（原本測的是舊的已儲存設定，會誤報成功）；成功時顯示實際使用的 Provider / 模型
- **Fix:** API Key 與 Provider 不符時（`sk-ant-` key 配 DeepSeek/OpenAI，或 Claude 配非 `sk-ant-` key）直接報錯說明；API 錯誤訊息前加上 Provider 與模型名稱
- **Change:** 標籤/分類分析（suggest_meta）改送純文字，去除 HTML 與 block 註解

## 1.6.0
- **Feat:** 段落工具新增「校稿整節」並設為選單第一項（預設）：從目前段落往上找最近的標題，校稿「該標題＋到下一個標題前的所有段落」（含清單項目），一次送出、一次預覽、一次採用
  - 每段以 `[[§n]]` 標記送出，AI 回來後拆回各自的 block；段落數或順序被打亂時報錯、不套用
  - 預覽只列出有修改的段落；連結/格式一樣以 `[[n]]` 標記保留
- **Change:** 工具列圖示由齒輪改為校稿圖示（`editor-spellcheck`），單段的各 prompt 改列為「本段：…」

## 1.5.0
- **Change:** DeepSeek 模型改為 `deepseek-flash`（V4.1 Flash）/ `deepseek-v4-pro`；`deepseek-chat` / `deepseek-reasoner` 已是官方宣布停用的舊別名
- **Fix:** DeepSeek 請求固定帶 `thinking: {type: "disabled"}`。V4 預設思考，思考 token 計入 max_tokens，2048 時常整個用在思考而回傳空內容；非思考模式也讓 temperature 生效
- **Fix:** `finish_reason === "length"` 時回錯誤，不再把被截斷的校稿結果交給使用者套用（原本長文後半段會無聲消失）
- **Change:** `max_tokens` 改為上限（預設 32768，設定頁上限 393216）；實際值依輸入長度自動計算：`max(4096, 1.5 × 字數 + 1024)`
- **Change:** 「模型最大 Context」預設改為 1,600,000 字元（1M tokens）；API timeout 120s → 300s

## 1.4.2
- **Fix:** 段落工具 AI 修改預覽寬度：改在執行期量測 block 元素的寬度與左邊界套用到預覽框（ResizeObserver 跟著變），不再依賴 `--wp--style--global--content-size`（classic theme 沒有這個變數、且 editor.css 不會載入 iframe 編輯器）
- **Fix:** 段落工具套用後吃掉連結與屬性：送出前把 inline HTML（`<a>`、`<strong>`、`<em>`、`<code>`、`<br>`…）換成 `[[n]]…[[/n]]` / `[[n/]]` 標記，AI 回來後再換回**原始標籤**（href/target/rel/class 全保留）；AI 弄丟或打亂的標記會在預覽中警告
- **Fix:** 段落預覽 diff 中文改為逐字比對（原本以空白斷詞，中文整段變成一個 token 而整段刪除＋整段新增）

## 1.4.0
- **Feat:** 「AI 標籤與分類」與「產生摘要」合併為單一面板，一個「AI 分析文章」按鍵同時呼叫 `suggest_meta` + `summarize`（`Promise.all` 並行），減少操作步驟
- **Feat:** 建議標題改為 checkbox（預設勾選），套用時連同 tags + 分類一起處理，不再有獨立的「套用標題」按鈕
- **Feat:** AI 摘要結果顯示在同一面板，提供「插入到文章頂部」/「設定為文章摘要」/「複製」/「捨棄」按鈕
- **Feat:** 套用建議後不清除建議內容，使用者可重複點選「套用選取的建議」
- **Feat:** 新增 `model_max_input_chars` 設定（模型本身最大 Context，預設 131072，0 = 不限），與外掛限制分開管理
- **Change:** `max_input_chars` 預設值從 20,000 改為 131,072
- **Change:** 整篇校稿超出 `max_input_chars` 時，改為彈出警告訊息並**中止**（原為 confirm 詢問是否繼續），並提示改用逐段校稿或更換支援更大 Context 的模型
- **Change:** 摘要/標籤/分類送出前靜默截斷至側邊欄的最大輸入字元值，不再詢問

## 1.3.2
- **Fix/Redesign:** AI 建議標籤與分類改為「分析 → 選取 → 套用」流程：
  - 分析完成後顯示灰底「AI 建議」區塊，標籤以可切換 chip 呈現（預設全選藍色，點選可取消），分類以預打勾 checkbox 呈現
  - 新增「套用選取的建議」按鈕，一次套用所有選取的 tags + 分類，套用後建議區塊消失
  - 建議標題保留獨立「套用標題」按鈕
  - 常用標籤（常用標籤點選新增）與自訂輸入維持即時套用，不受 AI 建議流程影響

## 1.3.0
- **Fix:** AI 標籤/分類分析送出前不再跳出字元數警告 dialog（該警告只適用於校稿/摘要）；後端已自動截斷至 `max_input_chars`，前端無需再次確認

## 1.2.9
- **Feat:** AI 標籤/分類面板新增「常用標籤」區塊，顯示使用次數最多的 20 個 tag，點選即時新增
- **Feat:** AI 建議標籤可直接編輯（chip + 自訂輸入），分類顯示 AI 建議 + 全部分類展開列表
- **Fix:** `handleAnalyze` 呼叫不存在的 `checkContentLimit`，改為 `confirmIfLarge`，修正 API 送出後一直轉圈問題

## 1.2.5
- **Fix:** Block 工具列 inline diff 預覽寬度過寬問題。`paragraph-tools.js` 的 HOC diffPanel 不受 Gutenberg content-width 限制，改用 `className` + `editor.css` 的 `max-width: var(--wp--style--global--content-size)` 強制限寬。

## 1.2.3
- **Feat:** 送出給 AI 的輸入字元數限制邏輯分流：
  - `suggest_meta`（tags/分類/標題）：自動截斷至 `max_input_chars` 設定值
  - 全文校稿、摘要：不截斷，但超出上限時 JS 彈出確認框，讓使用者決定是否送出全文

## 1.2.2
- **Feat:** 新增「最大輸入字元數」設定（預設 20,000 字元 ≈ 10K tokens 中文）
- **Feat:** AI 建議標籤/分類面板新增手動輸入欄，可覆蓋全域上限

## 1.2.0
- **Fix:** 校稿結果套用後 `**粗體**` 遺失：新增 `markdownToHtml()` 轉換 `**text**` → `<strong>` 再套用至文章
- **Fix:** 校稿結果套用後 HTML 超連結（`<a>` 標籤）消失：改用 `innerHTML` 保留 inline HTML，並在 system prompt 加入保留連結的指令
- **Feat:** Prompt 管理頁新增「回復預設值」按鈕，呼叫 REST API `POST /prompts-reset` 還原出廠 prompts
