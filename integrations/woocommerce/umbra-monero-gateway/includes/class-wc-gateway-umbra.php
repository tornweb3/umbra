<?php
/**
 * Umbra payment gateway: creates an invoice on checkout, sends the buyer to the
 * hosted Umbra checkout, and completes the order from the signed webhook.
 */

if (!defined('ABSPATH')) {
    exit;
}

class WC_Gateway_Umbra extends WC_Payment_Gateway
{
    public function __construct()
    {
        $this->id                 = 'umbra_monero';
        $this->method_title       = __('Umbra Monero', 'umbra-monero');
        $this->method_description = __(
            'Accept Monero non-custodially. Buyers pay on a hosted Umbra checkout page and the order completes automatically once the payment confirms on-chain.',
            'umbra-monero'
        );
        $this->has_fields = false;
        $this->supports   = ['products'];
        $this->icon       = '';

        $this->init_form_fields();
        $this->init_settings();

        $this->title       = $this->get_option('title');
        $this->description = $this->get_option('description');

        add_action('woocommerce_update_options_payment_gateways_' . $this->id, [$this, 'process_admin_options']);
    }

    public function init_form_fields()
    {
        $callback = add_query_arg('wc-api', 'umbra_monero', home_url('/'));

        $this->form_fields = [
            'enabled' => [
                'title'   => __('Enable/Disable', 'umbra-monero'),
                'type'    => 'checkbox',
                'label'   => __('Enable Monero payments via Umbra', 'umbra-monero'),
                'default' => 'no',
            ],
            'title' => [
                'title'       => __('Title', 'umbra-monero'),
                'type'        => 'text',
                'description' => __('What buyers see at checkout.', 'umbra-monero'),
                'default'     => __('Monero (XMR)', 'umbra-monero'),
                'desc_tip'    => true,
            ],
            'description' => [
                'title'    => __('Description', 'umbra-monero'),
                'type'     => 'textarea',
                'default'  => __('Pay privately with Monero. You will be shown a QR code and address to pay from your own wallet.', 'umbra-monero'),
                'desc_tip' => true,
            ],
            'api_base' => [
                'title'       => __('Umbra API URL', 'umbra-monero'),
                'type'        => 'text',
                'description' => __('Your Umbra gateway, without a trailing slash.', 'umbra-monero'),
                'default'     => 'https://www.umbra.international',
                'desc_tip'    => true,
            ],
            'api_key' => [
                'title'       => __('API key', 'umbra-monero'),
                'type'        => 'password',
                'description' => __('The xmr_sk_… key from your Umbra dashboard.', 'umbra-monero'),
                'default'     => '',
                'desc_tip'    => true,
            ],
            'webhook_secret' => [
                'title'       => __('Webhook secret', 'umbra-monero'),
                'type'        => 'password',
                'description' => sprintf(
                    /* translators: %s: the callback URL to paste into Umbra */
                    __('Shown once at Umbra signup (or rotate it in Settings). Set your Umbra webhook URL to: %s', 'umbra-monero'),
                    '<code>' . esc_html($callback) . '</code>'
                ),
                'default'  => '',
            ],
            'complete_on' => [
                'title'       => __('Complete the order at', 'umbra-monero'),
                'type'        => 'select',
                'description' => __('0-conf is instant but reversible; confirmed is final. Digital goods that ship instantly are the usual reason to pick 0-conf.', 'umbra-monero'),
                'default'     => 'payment_confirmed',
                'options'     => [
                    'payment_confirmed' => __('Confirmed (recommended)', 'umbra-monero'),
                    'payment_detected'  => __('0-conf (detected)', 'umbra-monero'),
                ],
                'desc_tip' => true,
            ],
            'expires_in_minutes' => [
                'title'             => __('Invoice window (minutes)', 'umbra-monero'),
                'type'              => 'number',
                'description'       => __('How long the buyer has to pay before the rate is re-quoted. 5–1440.', 'umbra-monero'),
                'default'           => '60',
                'custom_attributes' => ['min' => '5', 'max' => '1440'],
                'desc_tip'          => true,
            ],
            'debug' => [
                'title'       => __('Debug log', 'umbra-monero'),
                'type'        => 'checkbox',
                'label'       => __('Log Umbra requests and webhooks to WooCommerce → Status → Logs', 'umbra-monero'),
                'default'     => 'no',
            ],
        ];
    }

    /** Hide the method when it cannot work, rather than failing at checkout. */
    public function is_available()
    {
        if ('yes' !== $this->get_option('enabled')) {
            return false;
        }
        if (!$this->get_option('api_key') || !$this->get_option('api_base')) {
            return false;
        }
        return in_array(get_woocommerce_currency(), UMBRA_WC_CURRENCIES, true);
    }

    private function log($message, $level = 'info')
    {
        if ('yes' !== $this->get_option('debug')) {
            return;
        }
        wc_get_logger()->log($level, $message, ['source' => 'umbra-monero']);
    }

    public function process_payment($order_id)
    {
        $order = wc_get_order($order_id);
        if (!$order) {
            return ['result' => 'failure'];
        }

        $body = [
            'price_amount'       => $order->get_total(),
            'price_currency'     => $order->get_currency(),
            'description'        => sprintf(
                /* translators: 1: order number, 2: site name */
                __('Order %1$s (%2$s)', 'umbra-monero'),
                $order->get_order_number(),
                get_bloginfo('name')
            ),
            'expires_in_minutes' => (int) $this->get_option('expires_in_minutes', 60),
            // Where the buyer lands after paying, and how the webhook finds this order.
            'return_url' => $order->get_checkout_order_received_url(),
            'metadata'   => [
                'platform'     => 'woocommerce',
                'order_id'     => $order->get_id(),
                'order_number' => (string) $order->get_order_number(),
                'site_url'     => home_url('/'),
            ],
        ];

        $response = wp_remote_post(
            untrailingslashit($this->get_option('api_base')) . '/api/invoices',
            [
                'timeout' => 45,
                'headers' => [
                    'Authorization' => 'Bearer ' . $this->get_option('api_key'),
                    'Content-Type'  => 'application/json',
                    'Accept'        => 'application/json',
                ],
                'body' => wp_json_encode($body),
            ]
        );

        if (is_wp_error($response)) {
            $this->log('invoice request failed: ' . $response->get_error_message(), 'error');
            wc_add_notice(__('Could not reach the Monero payment service. Please try again.', 'umbra-monero'), 'error');
            return ['result' => 'failure'];
        }

        $code = wp_remote_retrieve_response_code($response);
        $data = json_decode(wp_remote_retrieve_body($response), true);
        if ($code < 200 || $code >= 300 || empty($data['checkout_url']) || empty($data['invoice_id'])) {
            $detail = is_array($data) && !empty($data['error']) ? $data['error'] : 'HTTP ' . $code;
            $this->log('invoice rejected: ' . $detail, 'error');
            wc_add_notice(__('Could not start the Monero payment. Please try again or choose another method.', 'umbra-monero'), 'error');
            return ['result' => 'failure'];
        }

        $order->update_meta_data('_umbra_invoice_id', sanitize_text_field($data['invoice_id']));
        if (!empty($data['amount_xmr'])) {
            $order->update_meta_data('_umbra_amount_xmr', sanitize_text_field($data['amount_xmr']));
        }
        $order->set_transaction_id($data['invoice_id']);
        // on-hold reserves stock while the buyer pays; payment_complete() releases it.
        $order->update_status(
            'on-hold',
            sprintf(
                /* translators: 1: XMR amount, 2: invoice id */
                __('Awaiting Monero payment of %1$s XMR (Umbra invoice %2$s).', 'umbra-monero'),
                isset($data['amount_xmr']) ? $data['amount_xmr'] : '?',
                $data['invoice_id']
            )
        );
        $order->save();

        if (WC()->cart) {
            WC()->cart->empty_cart();
        }
        $this->log('order ' . $order->get_id() . ' -> invoice ' . $data['invoice_id']);

        return ['result' => 'success', 'redirect' => $data['checkout_url']];
    }

    /**
     * Umbra webhook receiver. Signature is HMAC-SHA256 (hex) of the raw body,
     * keyed with the webhook secret, in X-Webhook-Signature.
     */
    public function handle_webhook()
    {
        $raw    = file_get_contents('php://input');
        $sig    = isset($_SERVER['HTTP_X_WEBHOOK_SIGNATURE']) ? $_SERVER['HTTP_X_WEBHOOK_SIGNATURE'] : '';
        $secret = $this->get_option('webhook_secret');

        if (!$secret) {
            $this->log('webhook received but no secret configured', 'error');
            status_header(500);
            wp_send_json(['error' => 'webhook secret not configured'], 500);
        }
        // Never parse the body before the signature checks out.
        if (!is_string($sig) || !hash_equals(hash_hmac('sha256', $raw, $secret), $sig)) {
            $this->log('webhook rejected: bad signature', 'warning');
            status_header(401);
            wp_send_json(['error' => 'invalid signature'], 401);
        }

        $data = json_decode($raw, true);
        if (!is_array($data) || empty($data['invoice_id'])) {
            status_header(400);
            wp_send_json(['error' => 'malformed payload'], 400);
        }

        $order_id = isset($data['metadata']['order_id']) ? absint($data['metadata']['order_id']) : 0;
        $order    = $order_id ? wc_get_order($order_id) : false;
        // The invoice id must match the one we stored, so a valid signature for
        // some other order can't mark this one paid.
        if (!$order || $order->get_meta('_umbra_invoice_id') !== $data['invoice_id']) {
            $this->log('webhook for unknown order/invoice ' . $data['invoice_id'], 'warning');
            status_header(404);
            wp_send_json(['error' => 'order not found'], 404);
        }

        $event = isset($data['event']) ? $data['event'] : '';
        $this->log('webhook ' . $event . ' for order ' . $order->get_id());

        // Redeliveries are normal; treat an already-paid order as success.
        if ($order->is_paid()) {
            wp_send_json(['ok' => true, 'note' => 'already paid']);
        }

        $complete_on = $this->get_option('complete_on', 'payment_confirmed');

        if ('payment_detected' === $event) {
            $order->add_order_note(sprintf(
                /* translators: %s: amount received in XMR */
                __('Umbra: payment of %s XMR seen (0-conf), awaiting confirmations.', 'umbra-monero'),
                isset($data['amount_received_xmr']) ? $data['amount_received_xmr'] : '?'
            ));
            if ('payment_detected' !== $complete_on) {
                $order->save();
                wp_send_json(['ok' => true]);
            }
        }

        if ('payment_confirmed' === $event || 'payment_detected' === $event) {
            $txid = !empty($data['txids'][0]) ? sanitize_text_field($data['txids'][0]) : $data['invoice_id'];
            $order->add_order_note(sprintf(
                /* translators: 1: amount in XMR, 2: number of confirmations */
                __('Umbra: payment of %1$s XMR confirmed (%2$s conf).', 'umbra-monero'),
                isset($data['amount_received_xmr']) ? $data['amount_received_xmr'] : '?',
                isset($data['confirmations']) ? $data['confirmations'] : '0'
            ));
            $order->payment_complete($txid);
            $order->save();
            wp_send_json(['ok' => true]);
        }

        // Unknown event: acknowledge so Umbra stops retrying.
        wp_send_json(['ok' => true, 'note' => 'ignored event']);
    }
}
