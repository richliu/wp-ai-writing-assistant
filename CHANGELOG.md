# Changelog

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
