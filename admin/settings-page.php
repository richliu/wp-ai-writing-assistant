<?php
if ( ! defined( 'ABSPATH' ) ) exit;
if ( ! current_user_can( 'manage_options' ) ) {
    wp_die( esc_html__( '權限不足', 'ai-writing-assistant' ) );
}
?>
<div class="wrap ai-writing-admin">
    <h1>AI 寫作助手設定</h1>

    <div id="ai-writing-notice" class="notice" style="display:none"></div>

    <h2 class="nav-tab-wrapper">
        <a href="#tab-api"     class="nav-tab nav-tab-active" data-tab="api">API 設定</a>
        <a href="#tab-prompts" class="nav-tab"                data-tab="prompts">Prompt 管理</a>
    </h2>

    <!-- ── API 設定 ─────────────────────────────────────── -->
    <div id="tab-api" class="tab-content">
        <table class="form-table">
            <tr>
                <th><label for="api_provider">API Provider</label></th>
                <td>
                    <select id="api_provider" name="api_provider">
                        <option value="deepseek">DeepSeek</option>
                        <option value="openai">OpenAI</option>
                        <option value="custom">Custom（OpenAI 相容）</option>
                    </select>
                </td>
            </tr>
            <tr id="row-custom-endpoint" style="display:none">
                <th><label for="custom_endpoint">Custom API Endpoint</label></th>
                <td>
                    <input type="url" id="custom_endpoint" name="custom_endpoint"
                           class="regular-text" placeholder="https://your-api.example.com/v1/chat/completions">
                </td>
            </tr>
            <tr>
                <th><label for="api_key">API Key</label></th>
                <td>
                    <input type="password" id="api_key" name="api_key"
                           class="regular-text" placeholder="sk-...">
                    <p class="description">留空則不修改現有 Key</p>
                </td>
            </tr>
            <tr>
                <th><label for="model">模型</label></th>
                <td>
                    <input type="text" id="model" name="model"
                           class="regular-text" placeholder="deepseek-chat">
                    <p class="description">DeepSeek 預設：deepseek-chat；OpenAI 預設：gpt-4o</p>
                </td>
            </tr>
            <tr>
                <th><label for="model_max_input_chars">模型最大 Context（字元）</label></th>
                <td>
                    <input type="number" id="model_max_input_chars" name="model_max_input_chars"
                           class="small-text" min="0" max="2000000" step="1000" value="131072">
                    <p class="description">模型本身能接受的最大字元數（0 = 不限制）。</p>
                </td>
            </tr>
            <tr>
                <th><label for="max_input_chars">wp-ai-writing-assistant 限制（字元）</label></th>
                <td>
                    <input type="number" id="max_input_chars" name="max_input_chars"
                           class="small-text" min="0" max="2000000" step="1000" value="131072">
                    <p class="description">外掛送出給 AI 的最大字元數（0 = 不限制）。summarize / suggest_meta 會自動截斷；proofread 超出時會中止並提示改用逐段校稿。</p>
                </td>
            </tr>
            <tr>
                <th><label for="max_tokens">Max Output Tokens</label></th>
                <td>
                    <input type="number" id="max_tokens" name="max_tokens" class="small-text" min="256" max="32768" value="2048">
                    <p class="description">AI 回覆的最大 token 數。長文章校稿建議調高至 4096 以上。</p>
                </td>
            </tr>
            <tr>
                <th><label for="temperature">Temperature</label></th>
                <td>
                    <input type="number" id="temperature" name="temperature" class="small-text"
                           min="0" max="2" step="0.1" value="0.7">
                    <p class="description">0 = 最保守，1 = 預設，2 = 最創意</p>
                </td>
            </tr>
            <tr>
                <th><label for="force_traditional_chinese">強制繁體中文</label></th>
                <td>
                    <label>
                        <input type="checkbox" id="force_traditional_chinese" name="force_traditional_chinese" value="1">
                        全域啟用：所有 AI 回覆強制使用繁體中文
                    </label>
                    <p class="description">啟用後會在每次 Prompt 末尾追加「請務必使用繁體中文回覆」。編輯器側邊欄也可個別覆蓋此設定。</p>
                </td>
            </tr>
        </table>
        <p>
            <button id="btn-save-api" class="button button-primary">儲存 API 設定</button>
            <button id="btn-test-api" class="button button-secondary" style="margin-left:8px">測試連線</button>
            <span id="test-api-result" style="margin-left:12px"></span>
        </p>
    </div>

    <!-- ── Prompt 管理 ───────────────────────────────────── -->
    <div id="tab-prompts" class="tab-content" style="display:none">

        <p>
            <button id="btn-add-prompt" class="button button-primary">＋ 新增 Prompt</button>
            <button id="btn-reset-prompts" class="button button-secondary" style="margin-left:8px">回復預設值</button>
        </p>

        <table class="wp-list-table widefat fixed striped" id="prompts-table">
            <thead>
                <tr>
                    <th style="width:200px">名稱</th>
                    <th>Prompt 內容</th>
                    <th style="width:80px">預設</th>
                    <th style="width:140px">操作</th>
                </tr>
            </thead>
            <tbody id="prompts-tbody">
                <tr><td colspan="4">載入中…</td></tr>
            </tbody>
        </table>

        <!-- Add / Edit Modal -->
        <div id="prompt-modal" style="display:none">
            <div class="ai-modal-overlay"></div>
            <div class="ai-modal-box">
                <h3 id="modal-title">新增 Prompt</h3>
                <input type="hidden" id="modal-prompt-id">
                <table class="form-table">
                    <tr>
                        <th><label for="modal-name">名稱</label></th>
                        <td><input type="text" id="modal-name" class="regular-text"></td>
                    </tr>
                    <tr>
                        <th><label for="modal-prompt">Prompt</label></th>
                        <td><textarea id="modal-prompt" rows="6" class="large-text"></textarea></td>
                    </tr>
                </table>
                <p>
                    <button id="btn-modal-save"   class="button button-primary">儲存</button>
                    <button id="btn-modal-cancel" class="button" style="margin-left:8px">取消</button>
                </p>
            </div>
        </div>
    </div>
</div>
