<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class AI_Writing_API_Handler {

    private AI_Writing_Settings       $settings;
    private AI_Writing_Prompts_Manager $prompts;

    public function __construct() {
        $this->settings = new AI_Writing_Settings();
        $this->prompts  = new AI_Writing_Prompts_Manager();
    }

    /**
     * REST callback: POST /ai-writing/v1/process
     */
    public function process( WP_REST_Request $request ) {
        $content       = $request->get_param( 'content' );
        $action        = $request->get_param( 'action' );       // 'proofread' | 'paragraph' | 'summarize' | 'custom'
        $tone          = $request->get_param( 'tone' )          ?: '';
        $custom_prompt = $request->get_param( 'custom_prompt' ) ?: '';
        $prompt_id     = $request->get_param( 'prompt_id' )     ?: 'proofread';
        $force_zh_tw   = ! empty( $request->get_param( 'force_zh_tw' ) );

        if ( empty( trim( $content ) ) ) {
            return new WP_Error( 'empty_content', '內容不可為空', [ 'status' => 400 ] );
        }

        // Truncate input to limit token usage.
        // suggest_meta: always apply limit (from request param or setting).
        // Other actions: only apply if explicitly passed in request (JS handles the warning).
        $req_max = $request->get_param( 'max_input_chars' );
        if ( $action === 'suggest_meta' ) {
            $max_input_chars = (int) ( $req_max !== null ? $req_max : $this->settings->get( 'max_input_chars', 20000 ) );
        } else {
            $max_input_chars = $req_max !== null ? (int) $req_max : 0;
        }
        // Tag/category analysis only needs the text
        if ( $action === 'suggest_meta' ) {
            $content = $this->to_plain_text( $content );
        }
        if ( $max_input_chars > 0 ) {
            $content = $this->truncate_content( $content, $max_input_chars );
        }

        // suggest_meta: returns JSON { tags, categories } instead of plain text
        if ( $action === 'suggest_meta' ) {
            $existing_cats = $request->get_param( 'existing_categories' ) ?: [];
            $system_prompt = $this->build_suggest_meta_prompt( $force_zh_tw, $existing_cats, $custom_prompt );
            $result = $this->call_api( $system_prompt, $content );
            if ( is_wp_error( $result ) ) return $result;
            // Strip markdown fences AI sometimes adds
            $clean  = trim( preg_replace( '/^```[a-z]*\n?|\n?```$/i', '', trim( $result ) ) );
            $parsed = json_decode( $clean, true );
            return rest_ensure_response( [
                'title'      => $parsed['title']      ?? '',
                'slug'       => sanitize_title( $parsed['slug'] ?? '' ),
                'tags'       => $parsed['tags']       ?? [],
                'categories' => $parsed['categories'] ?? [],
            ] );
        }

        $keep_links    = $action !== 'summarize';
        $system_prompt = $this->build_system_prompt( $prompt_id, $tone, $custom_prompt, $force_zh_tw, $keep_links );
        if ( ! $keep_links ) {
            // Link-heavy posts otherwise yield a summary full of links the body already has
            $system_prompt .= "\n摘要請聚焦文章本身的論點與結論，盡量不要放超連結：連結已經在內文裡，"
                . "除非某個連結是理解重點不可或缺的（最多一個），否則只寫文字，不要附上連結或網址。";
        }

        // Section tool: each block starts with [[§n]]; results are split back per block
        if ( $action === 'section' ) {
            $system_prompt .= "\n重要：內文由多個段落組成，每個段落開頭有 [[§1]]、[[§2]] 這類段落標記。"
                . "請保留每一個段落標記、維持原本的順序與段落數，每個段落只修改它自己的內容，"
                . "不要合併、拆分、增加或刪除段落。";
        }

        // Paragraph/section tools replace inline HTML (links, bold, etc.) with [[n]]…[[/n]] / [[n/]] markers
        if ( in_array( $action, [ 'paragraph', 'section' ], true ) && preg_match( '/\[\[\/?\d+\/?\]\]/', $content ) ) {
            $system_prompt .= "\n重要：內文中的 [[1]]、[[/1]]、[[2/]] 這類標記代表原本的連結與格式，"
                . "請原封不動保留每一個標記，並讓它們繼續包住對應的文字（[[n]] 與 [[/n]] 必須成對）。"
                . "不要新增、刪除或改寫標記，也不要把它們轉成 Markdown 或 HTML。";
        }

        $result        = $this->call_api( $system_prompt, $content );

        if ( is_wp_error( $result ) ) {
            return $result;
        }

        return rest_ensure_response( [
            'result'   => $result,
            'provider' => $this->settings->get( 'api_provider', 'deepseek' ),
            'model'    => $this->settings->get( 'model', '' ),
        ] );
    }

    private function build_suggest_meta_prompt( bool $force_zh_tw = false, array $existing_cats = [], string $custom_prompt = '' ): string {
        $p  = '你是一個 WordPress 內容分類助手。請根據文章內容，建議合適的標籤（tags）和分類（categories）。';

        if ( ! empty( $existing_cats ) ) {
            $list = implode('、', $existing_cats );
            $p .= "\n\n本站現有的分類如下：{$list}";
            $p .= "\n請從上述現有分類中選出最適合的 1~2 個放入 categories。若現有分類均不適合，可額外建議新分類名稱。";
        }

        $p .= "\n\n只輸出純 JSON，不要有任何說明文字或 markdown code block，格式如下：";
        $p .= "\n{\"title\":\"建議標題\",\"slug\":\"english-keyword-slug\",\"tags\":[\"標籤1\",\"標籤2\",\"標籤3\"],\"categories\":[\"分類名稱\"]}";
        $p .= "\n建議 3~6 個標籤，1~2 個分類，1 個簡潔有力的文章標題。";
        $p .= "\nslug 是文章網址用的英文連結：不要逐字翻譯標題，只取 3~5 個最核心的英文關鍵字（產品名、技術名詞、主題），"
            . "全小寫、以 - 連接、不含中文與標點，總長不超過 50 字元，例如 \"nvidia-gb200-liquid-cooling\"。";
        if ( ! empty( trim( $custom_prompt ) ) ) {
            $p .= "\n使用者額外要求（套用在標題、slug、標籤與分類，但仍須只輸出上述 JSON）：" . $custom_prompt;
        }
        if ( $force_zh_tw ) {
            $p .= "\n請使用繁體中文。";
        }
        return $p;
    }

    private function build_system_prompt( string $prompt_id, string $tone, string $custom_prompt, bool $force_zh_tw = false, bool $keep_links = true ): string {
        $base = '';

        $prompt_obj = $this->prompts->get_by_id( $prompt_id );
        if ( $prompt_obj ) {
            $base = $prompt_obj['prompt'];
        }

        // Append tone instruction
        if ( ! empty( $tone ) ) {
            $tone_map = [
                'formal'       => '請使用正式語氣。',
                'casual'       => '請使用輕鬆口語的語氣。',
                'professional' => '請使用專業語氣。',
                'friendly'     => '請使用友善親切的語氣。',
                'academic'     => '請使用學術文章的語氣。',
            ];
            $tone_str = $tone_map[ $tone ] ?? '';
            if ( $tone_str ) {
                $base .= "\n" . $tone_str;
            }
        }

        // Append user's custom instruction
        if ( ! empty( trim( $custom_prompt ) ) ) {
            $base .= "\n額外要求：" . $custom_prompt;
        }

        // Preserve links when the AI re-emits the article
        if ( $keep_links ) $base .= "\n重要：請保留文章中所有的超連結（HTML <a> 標籤及其 href 屬性），不要移除或修改連結。";

        // Enforce Traditional Chinese (request param overrides global setting)
        $global_zh_tw = (bool) $this->settings->get( 'force_traditional_chinese', false );
        if ( $force_zh_tw || $global_zh_tw ) {
            $base .= "\n請務必使用繁體中文回覆。";
        }

        return $base;
    }

    /** Post HTML → plain text: drop block comments and tags, keep paragraph breaks */
    private function to_plain_text( string $html ): string {
        $text = preg_replace( '/<!--.*?-->/s', '', $html );
        $text = preg_replace( '#</(p|h[1-6]|li|blockquote|pre|div|tr)>|<br\s*/?>#i', "$0\n", $text );
        $text = html_entity_decode( wp_strip_all_tags( $text ), ENT_QUOTES, 'UTF-8' );
        return trim( preg_replace( "/\n{3,}/", "\n\n", preg_replace( "/[ \t]+\n/", "\n", $text ) ) );
    }

    private function truncate_content( string $content, int $max_chars ): string {
        if ( mb_strlen( $content ) <= $max_chars ) return $content;
        $cut = mb_substr( $content, 0, $max_chars );
        // Try to cut at a clean paragraph or sentence boundary
        $last_newline = mb_strrpos( $cut, "\n" );
        $last_period  = mb_strrpos( $cut, '。' );
        $boundary = max( $last_newline ?: 0, $last_period ?: 0 );
        if ( $boundary > (int) ( $max_chars * 0.8 ) ) {
            $cut = mb_substr( $content, 0, $boundary );
        }
        return $cut . "\n\n（以下內容超過輸入字元上限，已省略）";
    }

    private function call_api( string $system_prompt, string $user_content ) {
        $provider = $this->settings->get( 'api_provider', 'deepseek' );
        $api_key  = $this->settings->get( 'api_key', '' );
        $model    = $this->settings->get( 'model', 'deepseek-flash' );
        $cap      = (int) $this->settings->get( 'max_tokens', 32768 );
        $temp     = (float) $this->settings->get( 'temperature', 0.7 );

        if ( empty( $api_key ) ) {
            return new WP_Error( 'no_api_key', '尚未設定 API Key，請至設定頁面填入。', [ 'status' => 400 ] );
        }

        $providers = $this->settings->get( 'providers', [] );
        $endpoint  = $this->settings->get( 'custom_endpoint', '' );
        $label     = $providers[ $provider ]['label'] ?? $provider;

        // Anthropic keys start with sk-ant-; catch a key saved under the wrong provider
        $is_ant_key = strpos( $api_key, 'sk-ant-' ) === 0;
        if ( $provider === 'claude' && ! $is_ant_key ) {
            return new WP_Error( 'key_provider_mismatch', 'Provider 設為 Claude，但 API Key 不是 Anthropic 的 key（應以 sk-ant- 開頭）。', [ 'status' => 400 ] );
        }
        if ( in_array( $provider, [ 'deepseek', 'openai' ], true ) && $is_ant_key ) {
            return new WP_Error( 'key_provider_mismatch', "API Key 是 Claude（sk-ant-）的，但 Provider 設為 {$label}。請到設定頁把 Provider 改成 Claude 並儲存。", [ 'status' => 400 ] );
        }

        if ( $provider === 'custom' ) {
            if ( empty( $endpoint ) ) {
                return new WP_Error( 'no_endpoint', '請設定 Custom API Endpoint', [ 'status' => 400 ] );
            }
        } elseif ( isset( $providers[ $provider ]['endpoint'] ) ) {
            $endpoint = $providers[ $provider ]['endpoint'];
        } else {
            return new WP_Error( 'unknown_provider', '未知的 API Provider', [ 'status' => 400 ] );
        }

        // Proofread/rewrite re-emits the whole text: ~0.6 token per 中文字, so
        // 1.5 tokens/char + 1024 leaves headroom; floor 4096 covers 「展開段落」.
        // The setting is only the upper bound.
        $tokens = max( 4096, (int) ceil( mb_strlen( $user_content ) * 1.5 ) + 1024 );
        if ( $cap > 0 ) {
            $tokens = min( $tokens, $cap );
        }

        $is_claude = $provider === 'claude';

        if ( $is_claude ) {
            // Anthropic Messages API: system is top-level; current models reject
            // temperature and can't turn thinking off, so keep effort low for editing.
            $payload = [
                'model'      => $model,
                'max_tokens' => $tokens,
                'system'     => $system_prompt,
                'messages'   => [
                    [ 'role' => 'user', 'content' => $user_content ],
                ],
            ];
            if ( preg_match( '/^claude-(opus|sonnet|haiku|fable)-5/', $model ) ) {
                $payload['output_config'] = [ 'effort' => 'low' ];
            }
            $headers = [
                'Content-Type'      => 'application/json',
                'x-api-key'         => $api_key,
                'anthropic-version' => '2023-06-01',
            ];
        } else {
            $payload = [
                'model'       => $model,
                'max_tokens'  => $tokens,
                'temperature' => $temp,
                'messages'    => [
                    [ 'role' => 'system',  'content' => $system_prompt ],
                    [ 'role' => 'user',    'content' => $user_content  ],
                ],
            ];
            // DeepSeek models think by default; reasoning tokens count against
            // max_tokens and temperature is ignored. Editing tasks don't need it.
            if ( $provider === 'deepseek' ) {
                $payload['thinking'] = [ 'type' => 'disabled' ];
            }
            $headers = [
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . $api_key,
            ];
        }
        $body = wp_json_encode( $payload );

        $response = wp_remote_post( $endpoint, [
            'timeout' => 300,
            'headers' => $headers,
            'body'    => $body,
        ] );

        if ( is_wp_error( $response ) ) {
            return new WP_Error( 'api_request_failed', $response->get_error_message(), [ 'status' => 502 ] );
        }

        $status_code = wp_remote_retrieve_response_code( $response );
        $raw_body    = wp_remote_retrieve_body( $response );
        $data        = json_decode( $raw_body, true );

        if ( $status_code !== 200 ) {
            $msg = $data['error']['message'] ?? $raw_body;
            return new WP_Error( 'api_error', "{$label}（{$model}）API 回傳錯誤 {$status_code}: {$msg}", [ 'status' => 502 ] );
        }

        if ( $is_claude ) {
            // content may start with (empty) thinking blocks; join the text blocks
            $text = '';
            foreach ( $data['content'] ?? [] as $block ) {
                if ( ( $block['type'] ?? '' ) === 'text' ) $text .= $block['text'];
            }
            $stop = $data['stop_reason'] ?? '';
            if ( $stop === 'refusal' ) {
                return new WP_Error( 'api_refusal', 'Claude 拒絕處理此內容（stop_reason: refusal）。', [ 'status' => 502 ] );
            }
            $truncated = $stop === 'max_tokens';
        } else {
            $text      = $data['choices'][0]['message']['content'] ?? '';
            $truncated = ( $data['choices'][0]['finish_reason'] ?? '' ) === 'length';
        }
        if ( $truncated ) {
            return new WP_Error( 'output_truncated',
                "AI 輸出達到上限（max_tokens {$tokens}）被截斷，結果不完整，未套用。請調高設定頁的 Max Output Tokens，或改用逐段校稿。",
                [ 'status' => 502 ] );
        }
        if ( empty( $text ) ) {
            return new WP_Error( 'empty_response', 'API 回傳空內容', [ 'status' => 502 ] );
        }

        return $text;
    }
}
