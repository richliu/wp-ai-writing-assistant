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
        if ( $max_input_chars > 0 ) {
            $content = $this->truncate_content( $content, $max_input_chars );
        }

        // suggest_meta: returns JSON { tags, categories } instead of plain text
        if ( $action === 'suggest_meta' ) {
            $existing_cats = $request->get_param( 'existing_categories' ) ?: [];
            $system_prompt = $this->build_suggest_meta_prompt( $force_zh_tw, $existing_cats );
            $result = $this->call_api( $system_prompt, $content );
            if ( is_wp_error( $result ) ) return $result;
            // Strip markdown fences AI sometimes adds
            $clean  = trim( preg_replace( '/^```[a-z]*\n?|\n?```$/i', '', trim( $result ) ) );
            $parsed = json_decode( $clean, true );
            return rest_ensure_response( [
                'title'      => $parsed['title']      ?? '',
                'tags'       => $parsed['tags']       ?? [],
                'categories' => $parsed['categories'] ?? [],
            ] );
        }

        $system_prompt = $this->build_system_prompt( $prompt_id, $tone, $custom_prompt, $force_zh_tw );
        $result        = $this->call_api( $system_prompt, $content );

        if ( is_wp_error( $result ) ) {
            return $result;
        }

        return rest_ensure_response( [ 'result' => $result ] );
    }

    private function build_suggest_meta_prompt( bool $force_zh_tw = false, array $existing_cats = [] ): string {
        $p  = '你是一個 WordPress 內容分類助手。請根據文章內容，建議合適的標籤（tags）和分類（categories）。';

        if ( ! empty( $existing_cats ) ) {
            $list = implode('、', $existing_cats );
            $p .= "\n\n本站現有的分類如下：{$list}";
            $p .= "\n請從上述現有分類中選出最適合的 1~2 個放入 categories。若現有分類均不適合，可額外建議新分類名稱。";
        }

        $p .= "\n\n只輸出純 JSON，不要有任何說明文字或 markdown code block，格式如下：";
        $p .= "\n{\"title\":\"建議標題\",\"tags\":[\"標籤1\",\"標籤2\",\"標籤3\"],\"categories\":[\"分類名稱\"]}";
        $p .= "\n建議 3~6 個標籤，1~2 個分類，1 個簡潔有力的文章標題。";
        if ( $force_zh_tw ) {
            $p .= "\n請使用繁體中文。";
        }
        return $p;
    }

    private function build_system_prompt( string $prompt_id, string $tone, string $custom_prompt, bool $force_zh_tw = false ): string {
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

        // Always preserve links
        $base .= "\n重要：請保留文章中所有的超連結（HTML <a> 標籤及其 href 屬性），不要移除或修改連結。";

        // Enforce Traditional Chinese (request param overrides global setting)
        $global_zh_tw = (bool) $this->settings->get( 'force_traditional_chinese', false );
        if ( $force_zh_tw || $global_zh_tw ) {
            $base .= "\n請務必使用繁體中文回覆。";
        }

        return $base;
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
        $model    = $this->settings->get( 'model', 'deepseek-chat' );
        $tokens   = (int) $this->settings->get( 'max_tokens', 2048 );
        $temp     = (float) $this->settings->get( 'temperature', 0.7 );

        if ( empty( $api_key ) ) {
            return new WP_Error( 'no_api_key', '尚未設定 API Key，請至設定頁面填入。', [ 'status' => 400 ] );
        }

        $providers = $this->settings->get( 'providers', [] );
        $endpoint  = $this->settings->get( 'custom_endpoint', '' );

        if ( $provider === 'custom' ) {
            if ( empty( $endpoint ) ) {
                return new WP_Error( 'no_endpoint', '請設定 Custom API Endpoint', [ 'status' => 400 ] );
            }
        } elseif ( isset( $providers[ $provider ]['endpoint'] ) ) {
            $endpoint = $providers[ $provider ]['endpoint'];
        } else {
            return new WP_Error( 'unknown_provider', '未知的 API Provider', [ 'status' => 400 ] );
        }

        $body = wp_json_encode( [
            'model'       => $model,
            'max_tokens'  => $tokens,
            'temperature' => $temp,
            'messages'    => [
                [ 'role' => 'system',  'content' => $system_prompt ],
                [ 'role' => 'user',    'content' => $user_content  ],
            ],
        ] );

        $response = wp_remote_post( $endpoint, [
            'timeout' => 120,
            'headers' => [
                'Content-Type'  => 'application/json',
                'Authorization' => 'Bearer ' . $api_key,
            ],
            'body' => $body,
        ] );

        if ( is_wp_error( $response ) ) {
            return new WP_Error( 'api_request_failed', $response->get_error_message(), [ 'status' => 502 ] );
        }

        $status_code = wp_remote_retrieve_response_code( $response );
        $raw_body    = wp_remote_retrieve_body( $response );
        $data        = json_decode( $raw_body, true );

        if ( $status_code !== 200 ) {
            $msg = $data['error']['message'] ?? $raw_body;
            return new WP_Error( 'api_error', "API 回傳錯誤 {$status_code}: {$msg}", [ 'status' => 502 ] );
        }

        $text = $data['choices'][0]['message']['content'] ?? '';
        if ( empty( $text ) ) {
            return new WP_Error( 'empty_response', 'API 回傳空內容', [ 'status' => 502 ] );
        }

        return $text;
    }
}
