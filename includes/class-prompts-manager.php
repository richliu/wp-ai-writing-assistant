<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class AI_Writing_Prompts_Manager {

    const OPTION_KEY = 'ai_writing_prompts';

    private function default_prompts(): array {
        return [
            [
                'id'        => 'proofread',
                'name'      => '校稿（預設）',
                'prompt'    => '請幫我校稿以下文章，修正錯別字、語句不通順的地方，保持原有的意思與語氣。請保留文章中所有的超連結（HTML <a> 標籤），不要移除或修改連結。如果需要加粗文字請使用 **文字** 格式。只回傳修改後的文章內容，不要加任何說明。',
                'is_default' => true,
            ],
            [
                'id'        => 'rewrite_formal',
                'name'      => '改寫為正式語氣',
                'prompt'    => '請將以下文章改寫為正式、專業的語氣，保持原有的資訊內容。請保留文章中所有的超連結（HTML <a> 標籤），不要移除或修改連結。只回傳改寫後的文章，不要加說明。',
                'is_default' => false,
            ],
            [
                'id'        => 'rewrite_casual',
                'name'      => '改寫為輕鬆語氣',
                'prompt'    => '請將以下文章改寫為輕鬆、親切的口語風格，保持原有的資訊內容。請保留文章中所有的超連結（HTML <a> 標籤），不要移除或修改連結。只回傳改寫後的文章，不要加說明。',
                'is_default' => false,
            ],
            [
                'id'          => 'summarize',
                'name'        => '摘要',
                'prompt'      => '請用簡短的三到五句話摘要以下文章的重點，只回傳摘要內容，不要加說明。',
                'is_default'  => false,
                'action_type' => 'summarize',
            ],
            [
                'id'        => 'expand',
                'name'      => '展開段落',
                'prompt'    => '請根據以下段落的概念，展開並豐富內容，增加細節與例子，只回傳展開後的段落，不要加說明。',
                'is_default' => false,
            ],
        ];
    }

    public function init_default_prompts() {
        if ( ! get_option( self::OPTION_KEY ) ) {
            add_option( self::OPTION_KEY, $this->default_prompts() );
        }
    }

    public function get_all(): array {
        $prompts = get_option( self::OPTION_KEY, [] );
        if ( empty( $prompts ) ) {
            $prompts = $this->default_prompts();
        }
        return array_values( $prompts );
    }

    public function get_by_id( string $id ): ?array {
        foreach ( $this->get_all() as $p ) {
            if ( $p['id'] === $id ) return $p;
        }
        return null;
    }

    public function create( array $data ): array {
        $prompts = $this->get_all();
        $new = [
            'id'         => 'custom_' . uniqid(),
            'name'       => sanitize_text_field( $data['name'] ?? '新 Prompt' ),
            'prompt'     => sanitize_textarea_field( $data['prompt'] ?? '' ),
            'is_default' => false,
        ];
        $prompts[] = $new;
        update_option( self::OPTION_KEY, $prompts );
        return $new;
    }

    public function update( string $id, array $data ): ?array {
        $prompts = $this->get_all();
        foreach ( $prompts as &$p ) {
            if ( $p['id'] === $id ) {
                if ( isset( $data['name'] ) )   $p['name']   = sanitize_text_field( $data['name'] );
                if ( isset( $data['prompt'] ) )  $p['prompt'] = sanitize_textarea_field( $data['prompt'] );
                update_option( self::OPTION_KEY, $prompts );
                return $p;
            }
        }
        return null;
    }

    public function delete( string $id ): bool {
        $prompts = $this->get_all();
        $default_prompt = array_filter( $prompts, fn($p) => $p['is_default'] );

        // Cannot delete if it's the only prompt or the default
        $target = $this->get_by_id( $id );
        if ( ! $target ) return false;
        if ( $target['is_default'] ) return false; // protect default
        if ( count( $prompts ) <= 1 ) return false;

        $prompts = array_values( array_filter( $prompts, fn($p) => $p['id'] !== $id ) );
        update_option( self::OPTION_KEY, $prompts );
        return true;
    }

    /**
     * Reset all prompts back to factory defaults.
     */
    public function reset_defaults(): array {
        $defaults = $this->default_prompts();
        update_option( self::OPTION_KEY, $defaults );
        return $defaults;
    }

    // ── REST callbacks ─────────────────────────────────────────────────────

    public function rest_get_all( WP_REST_Request $request ) {
        return rest_ensure_response( $this->get_all() );
    }

    public function rest_create( WP_REST_Request $request ) {
        $body = $request->get_json_params() ?: $request->get_params();
        if ( empty( $body['name'] ) || empty( $body['prompt'] ) ) {
            return new WP_Error( 'missing_fields', 'name 和 prompt 為必填', [ 'status' => 400 ] );
        }
        return rest_ensure_response( $this->create( $body ) );
    }

    public function rest_update( WP_REST_Request $request ) {
        $id   = $request->get_param( 'id' );
        $body = $request->get_json_params() ?: $request->get_params();
        $result = $this->update( $id, $body );
        if ( null === $result ) {
            return new WP_Error( 'not_found', '找不到此 Prompt', [ 'status' => 404 ] );
        }
        return rest_ensure_response( $result );
    }

    public function rest_reset_defaults( WP_REST_Request $request ) {
        $prompts = $this->reset_defaults();
        return rest_ensure_response( $prompts );
    }

    public function rest_delete( WP_REST_Request $request ) {
        $id = $request->get_param( 'id' );
        $ok = $this->delete( $id );
        if ( ! $ok ) {
            return new WP_Error( 'delete_failed', '無法刪除（預設 Prompt 或唯一 Prompt 不可刪除）', [ 'status' => 400 ] );
        }
        return rest_ensure_response( [ 'deleted' => true ] );
    }
}
