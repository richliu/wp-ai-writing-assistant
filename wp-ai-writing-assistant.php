<?php
/**
 * Plugin Name: AI Writing Assistant
 * Description: AI 寫作助手，支援整篇校稿、語氣調整、自訂 Prompt，支援 DeepSeek API
 * Version:     1.4.0
 * Author:      mytool
 * Text Domain: ai-writing-assistant
 */

if ( ! defined( 'ABSPATH' ) ) exit;

define( 'AI_WRITING_VERSION',    '1.4.0' );
define( 'AI_WRITING_DIR',        plugin_dir_path( __FILE__ ) );
define( 'AI_WRITING_URL',        plugin_dir_url( __FILE__ ) );

require_once AI_WRITING_DIR . 'includes/class-settings.php';
require_once AI_WRITING_DIR . 'includes/class-prompts-manager.php';
require_once AI_WRITING_DIR . 'includes/class-api-handler.php';

class AI_Writing_Assistant {

    private static $instance = null;

    public static function get_instance() {
        if ( null === self::$instance ) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        register_activation_hook( __FILE__, [ $this, 'activate' ] );

        add_action( 'init',                       [ $this, 'init' ] );
        add_action( 'enqueue_block_editor_assets', [ $this, 'enqueue_editor_assets' ] );
        add_action( 'admin_menu',                 [ $this, 'add_admin_menu' ] );
        add_action( 'admin_enqueue_scripts',      [ $this, 'enqueue_admin_assets' ] );
        add_action( 'rest_api_init',              [ $this, 'register_rest_routes' ] );
    }

    public function activate() {
        ( new AI_Writing_Prompts_Manager() )->init_default_prompts();
        ( new AI_Writing_Settings() )->init_defaults();
    }

    public function init() {
        load_plugin_textdomain(
            'ai-writing-assistant',
            false,
            dirname( plugin_basename( __FILE__ ) ) . '/languages'
        );
    }

    public function enqueue_editor_assets() {
        $prompts = ( new AI_Writing_Prompts_Manager() )->get_all();

        wp_enqueue_script(
            'ai-writing-sidebar',
            AI_WRITING_URL . 'assets/js/editor-sidebar.js',
            [ 'wp-plugins', 'wp-edit-post', 'wp-element', 'wp-components',
              'wp-data', 'wp-api-fetch', 'wp-i18n' ],
            AI_WRITING_VERSION,
            true
        );

        wp_enqueue_script(
            'ai-writing-paragraph-tools',
            AI_WRITING_URL . 'assets/js/paragraph-tools.js',
            [ 'wp-blocks', 'wp-hooks', 'wp-element', 'wp-components',
              'wp-block-editor', 'wp-compose', 'wp-api-fetch' ],
            AI_WRITING_VERSION,
            true
        );

        $settings_obj = new AI_Writing_Settings();
        $shared = [
            'restUrl'  => esc_url_raw( rest_url( 'ai-writing/v1' ) ),
            'nonce'    => wp_create_nonce( 'wp_rest' ),
            'prompts'  => $prompts,
            'settings' => [
                'force_traditional_chinese' => (bool) $settings_obj->get( 'force_traditional_chinese', false ),
                'max_input_chars'           => (int)  $settings_obj->get( 'max_input_chars', 131072 ),
                'model_max_input_chars'     => (int)  $settings_obj->get( 'model_max_input_chars', 131072 ),
            ],
        ];
        wp_localize_script( 'ai-writing-sidebar',         'aiWritingData', $shared );
        wp_localize_script( 'ai-writing-paragraph-tools', 'aiWritingData', $shared );

        wp_enqueue_style(
            'ai-writing-editor',
            AI_WRITING_URL . 'assets/css/editor.css',
            [],
            AI_WRITING_VERSION
        );
    }

    public function add_admin_menu() {
        add_options_page(
            'AI 寫作助手設定',
            'AI 寫作助手',
            'manage_options',
            'ai-writing-assistant',
            [ $this, 'render_settings_page' ]
        );
    }

    public function enqueue_admin_assets( $hook ) {
        if ( 'settings_page_ai-writing-assistant' !== $hook ) return;

        wp_enqueue_script(
            'ai-writing-admin',
            AI_WRITING_URL . 'assets/js/admin-settings.js',
            [ 'jquery' ],
            AI_WRITING_VERSION,
            true
        );
        wp_localize_script( 'ai-writing-admin', 'aiWritingAdmin', [
            'restUrl' => esc_url_raw( rest_url( 'ai-writing/v1' ) ),
            'nonce'   => wp_create_nonce( 'wp_rest' ),
            'prompts' => ( new AI_Writing_Prompts_Manager() )->get_all(),
        ] );

        wp_enqueue_style(
            'ai-writing-admin',
            AI_WRITING_URL . 'assets/css/admin.css',
            [],
            AI_WRITING_VERSION
        );
    }

    public function render_settings_page() {
        require_once AI_WRITING_DIR . 'admin/settings-page.php';
    }

    public function register_rest_routes() {
        $api     = new AI_Writing_API_Handler();
        $prompts = new AI_Writing_Prompts_Manager();
        $can_edit    = function() { return current_user_can( 'edit_posts' ); };
        $can_manage  = function() { return current_user_can( 'manage_options' ); };

        // ── Process (call AI) ──────────────────────────────────────────────
        register_rest_route( 'ai-writing/v1', '/process', [
            'methods'             => 'POST',
            'callback'            => [ $api, 'process' ],
            'permission_callback' => $can_edit,
            'args'                => [
                'content'       => [ 'required' => true,  'sanitize_callback' => 'wp_kses_post' ],
                'action'        => [ 'required' => true,  'sanitize_callback' => 'sanitize_text_field' ],
                'tone'          => [ 'sanitize_callback' => 'sanitize_text_field' ],
                'custom_prompt' => [ 'sanitize_callback' => 'sanitize_textarea_field' ],
                'prompt_id'           => [ 'sanitize_callback' => 'sanitize_text_field' ],
                'existing_categories' => [
                    'default'           => [],
                    'sanitize_callback' => function( $val ) {
                        if ( ! is_array( $val ) ) return [];
                        return array_map( 'sanitize_text_field', $val );
                    },
                ],
            ],
        ] );

        // ── Prompts CRUD ───────────────────────────────────────────────────
        register_rest_route( 'ai-writing/v1', '/prompts', [
            [ 'methods' => 'GET',  'callback' => [ $prompts, 'rest_get_all' ], 'permission_callback' => $can_edit ],
            [ 'methods' => 'POST', 'callback' => [ $prompts, 'rest_create' ],  'permission_callback' => $can_manage ],
        ] );
        register_rest_route( 'ai-writing/v1', '/prompts/(?P<id>[a-zA-Z0-9_-]+)', [
            [ 'methods' => 'PUT',    'callback' => [ $prompts, 'rest_update' ], 'permission_callback' => $can_manage ],
            [ 'methods' => 'DELETE', 'callback' => [ $prompts, 'rest_delete' ], 'permission_callback' => $can_manage ],
        ] );
        register_rest_route( 'ai-writing/v1', '/prompts-reset', [
            'methods'             => 'POST',
            'callback'            => [ $prompts, 'rest_reset_defaults' ],
            'permission_callback' => $can_manage,
        ] );

        // ── Settings ───────────────────────────────────────────────────────
        $settings = new AI_Writing_Settings();
        register_rest_route( 'ai-writing/v1', '/settings', [
            [ 'methods' => 'GET',  'callback' => [ $settings, 'rest_get' ],    'permission_callback' => $can_manage ],
            [ 'methods' => 'POST', 'callback' => [ $settings, 'rest_update' ], 'permission_callback' => $can_manage ],
        ] );
    }
}

AI_Writing_Assistant::get_instance();
