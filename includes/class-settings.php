<?php
if ( ! defined( 'ABSPATH' ) ) exit;

class AI_Writing_Settings {

    const OPTION_KEY = 'ai_writing_settings';

    private $defaults = [
        'api_provider'             => 'deepseek',
        'api_key'                  => '',
        'model'                    => 'deepseek-chat',
        'max_tokens'               => 2048,
        'max_input_chars'          => 131072,
        'model_max_input_chars'    => 131072,
        'temperature'              => 0.7,
        'force_traditional_chinese' => false,
        'providers'    => [
            'deepseek' => [
                'label'    => 'DeepSeek',
                'endpoint' => 'https://api.deepseek.com/v1/chat/completions',
                'models'   => [ 'deepseek-chat', 'deepseek-reasoner' ],
            ],
            'openai' => [
                'label'    => 'OpenAI',
                'endpoint' => 'https://api.openai.com/v1/chat/completions',
                'models'   => [ 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo' ],
            ],
            'custom' => [
                'label'    => 'Custom (OpenAI 相容)',
                'endpoint' => '',
                'models'   => [],
            ],
        ],
    ];

    public function init_defaults() {
        if ( ! get_option( self::OPTION_KEY ) ) {
            $save = $this->defaults;
            unset( $save['providers'] ); // providers are static, not stored
            add_option( self::OPTION_KEY, $save );
        }
    }

    public function get_all(): array {
        $saved = get_option( self::OPTION_KEY, [] );
        $merged = array_merge( $this->defaults, $saved );
        return $merged;
    }

    public function get( string $key, $fallback = null ) {
        return $this->get_all()[ $key ] ?? $fallback;
    }

    public function update( array $data ): array {
        $current = get_option( self::OPTION_KEY, [] );
        $allowed = [ 'api_provider', 'api_key', 'model', 'max_tokens', 'max_input_chars', 'model_max_input_chars', 'temperature', 'custom_endpoint', 'force_traditional_chinese' ];
        foreach ( $allowed as $k ) {
            if ( isset( $data[ $k ] ) ) {
                $current[ $k ] = $data[ $k ];
            }
        }
        update_option( self::OPTION_KEY, $current );
        return $current;
    }

    public function rest_get( WP_REST_Request $request ) {
        $all = $this->get_all();
        // Mask API key in response
        if ( ! empty( $all['api_key'] ) ) {
            $all['api_key_set'] = true;
            $all['api_key']     = str_repeat( '*', 8 ) . substr( $all['api_key'], -4 );
        } else {
            $all['api_key_set'] = false;
        }
        return rest_ensure_response( $all );
    }

    public function rest_update( WP_REST_Request $request ) {
        $body = $request->get_json_params() ?: $request->get_params();
        // If api_key is masked, don't overwrite the real one
        if ( isset( $body['api_key'] ) && strpos( $body['api_key'], '****' ) !== false ) {
            unset( $body['api_key'] );
        }
        $updated = $this->update( $body );
        return rest_ensure_response( [ 'success' => true, 'settings' => $updated ] );
    }
}
