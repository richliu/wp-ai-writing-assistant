/* global jQuery, aiWritingAdmin */
(function ($) {
    'use strict';

    const REST  = aiWritingAdmin.restUrl;
    const NONCE = aiWritingAdmin.nonce;

    function apiFetch(path, method, data) {
        return $.ajax({
            url: REST + path,
            method: method || 'GET',
            contentType: 'application/json',
            data: data ? JSON.stringify(data) : undefined,
            beforeSend: xhr => xhr.setRequestHeader('X-WP-Nonce', NONCE),
        });
    }

    function showNotice(msg, type) {
        $('#ai-writing-notice')
            .removeClass('notice-success notice-error notice-warning')
            .addClass('notice notice-' + (type || 'success'))
            .html('<p>' + msg + '</p>')
            .show();
    }

    // ── Tab switching ───────────────────────────────────────────────────────
    $('.nav-tab').on('click', function (e) {
        e.preventDefault();
        $('.nav-tab').removeClass('nav-tab-active');
        $(this).addClass('nav-tab-active');
        $('.tab-content').hide();
        $('#tab-' + $(this).data('tab')).show();
    });

    // ── Custom endpoint visibility ──────────────────────────────────────────
    $('#api_provider').on('change', function () {
        $('#row-custom-endpoint').toggle($(this).val() === 'custom');
    });

    // ── Load API settings ───────────────────────────────────────────────────
    function loadSettings() {
        apiFetch('/settings').done(function (data) {
            $('#api_provider').val(data.api_provider || 'deepseek').trigger('change');
            $('#model').val(data.model || '');
            $('#max_tokens').val(data.max_tokens || 2048);
            $('#temperature').val(data.temperature || 0.7);
            $('#custom_endpoint').val(data.custom_endpoint || '');
            $('#force_traditional_chinese').prop('checked', !!data.force_traditional_chinese);
            $('#max_input_chars').val(data.max_input_chars ?? 131072);
            $('#model_max_input_chars').val(data.model_max_input_chars ?? 131072);
            // api_key is masked, leave input empty
        }).fail(function () {
            showNotice('載入設定失敗', 'error');
        });
    }

    // ── Save API settings ───────────────────────────────────────────────────
    $('#btn-save-api').on('click', function () {
        const payload = {
            api_provider:             $('#api_provider').val(),
            model:                    $('#model').val(),
            max_tokens:               parseInt($('#max_tokens').val(), 10),
            temperature:              parseFloat($('#temperature').val()),
            custom_endpoint:          $('#custom_endpoint').val(),
            force_traditional_chinese: $('#force_traditional_chinese').is(':checked'),
            max_input_chars:          parseInt($('#max_input_chars').val(), 10) || 0,
            model_max_input_chars:    parseInt($('#model_max_input_chars').val(), 10) || 0,
        };
        const apiKey = $('#api_key').val();
        if (apiKey) payload.api_key = apiKey;

        apiFetch('/settings', 'POST', payload)
            .done(() => {
                showNotice('API 設定已儲存！');
                $('#api_key').val(''); // clear after save
            })
            .fail(xhr => showNotice('儲存失敗：' + (xhr.responseJSON?.message || '未知錯誤'), 'error'));
    });

    // ── Test API connection ─────────────────────────────────────────────────
    $('#btn-test-api').on('click', function () {
        const $result = $('#test-api-result');
        $result.text('測試中…');
        apiFetch('/process', 'POST', {
            content: '這是一段測試文字。',
            action: 'proofread',
            prompt_id: 'proofread',
        })
            .done(() => $result.css('color', 'green').text('✓ 連線成功！'))
            .fail(xhr => $result.css('color', 'red').text('✗ 失敗：' + (xhr.responseJSON?.message || '請確認 API Key')));
    });

    // ── Load prompts table ──────────────────────────────────────────────────
    let allPrompts = [];

    function renderPrompts(prompts) {
        allPrompts = prompts;
        const $tbody = $('#prompts-tbody').empty();
        prompts.forEach(function (p) {
            const $tr = $('<tr>');
            $tr.append($('<td>').text(p.name));
            $tr.append($('<td>').text(p.prompt.length > 100 ? p.prompt.slice(0, 100) + '…' : p.prompt));
            $tr.append($('<td>').html(p.is_default ? '<span class="dashicons dashicons-yes-alt" title="預設"></span>' : ''));

            const $actions = $('<td>');
            $('<button class="button button-small">編輯</button>')
                .on('click', () => openModal(p))
                .appendTo($actions);

            if (!p.is_default) {
                $(' ').appendTo($actions);
                $('<button class="button button-small button-link-delete" style="margin-left:6px">刪除</button>')
                    .on('click', () => deletePrompt(p.id, p.name))
                    .appendTo($actions);
            }
            $tr.append($actions);
            $tbody.append($tr);
        });
    }

    function loadPrompts() {
        apiFetch('/prompts')
            .done(renderPrompts)
            .fail(() => showNotice('載入 Prompt 失敗', 'error'));
    }

    // ── Modal ───────────────────────────────────────────────────────────────
    function openModal(prompt) {
        if (prompt) {
            $('#modal-title').text('編輯 Prompt');
            $('#modal-prompt-id').val(prompt.id);
            $('#modal-name').val(prompt.name);
            $('#modal-prompt').val(prompt.prompt);
        } else {
            $('#modal-title').text('新增 Prompt');
            $('#modal-prompt-id').val('');
            $('#modal-name').val('');
            $('#modal-prompt').val('');
        }
        $('#prompt-modal').show();
    }

    function closeModal() {
        $('#prompt-modal').hide();
    }

    $('#btn-add-prompt').on('click', () => openModal(null));
    $('#btn-modal-cancel').on('click', closeModal);
    $('.ai-modal-overlay').on('click', closeModal);

    $('#btn-modal-save').on('click', function () {
        const id     = $('#modal-prompt-id').val();
        const name   = $('#modal-name').val().trim();
        const prompt = $('#modal-prompt').val().trim();

        if (!name || !prompt) {
            alert('名稱和 Prompt 不可為空');
            return;
        }

        const payload = { name, prompt };
        const req = id
            ? apiFetch('/prompts/' + id, 'PUT', payload)
            : apiFetch('/prompts', 'POST', payload);

        req
            .done(() => { closeModal(); loadPrompts(); showNotice('已儲存！'); })
            .fail(xhr => showNotice('儲存失敗：' + (xhr.responseJSON?.message || ''), 'error'));
    });

    function deletePrompt(id, name) {
        if (!confirm('確定要刪除「' + name + '」？')) return;
        apiFetch('/prompts/' + id, 'DELETE')
            .done(() => { loadPrompts(); showNotice('已刪除。'); })
            .fail(xhr => showNotice('刪除失敗：' + (xhr.responseJSON?.message || ''), 'error'));
    }

    // ── Reset prompts to defaults ────────────────────────────────────────────
    $('#btn-reset-prompts').on('click', function () {
        if (!confirm('確定要將所有 Prompt 回復為預設值？\n自訂的 Prompt 將會被刪除。')) return;
        apiFetch('/prompts-reset', 'POST')
            .done(function (data) {
                renderPrompts(data);
                showNotice('已回復預設值！');
            })
            .fail(function (xhr) {
                showNotice('回復失敗：' + (xhr.responseJSON?.message || '未知錯誤'), 'error');
            });
    });

    // ── Init ────────────────────────────────────────────────────────────────
    loadSettings();
    loadPrompts();

})(jQuery);
