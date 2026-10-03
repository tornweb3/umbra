<?php
/**
 * Registers the gateway with the block-based checkout. The classic checkout
 * needs none of this; blocks render payment methods in React, so the method
 * has to ship a script that registers itself client-side.
 */

if (!defined('ABSPATH')) {
    exit;
}

use Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType;

final class Umbra_Blocks_Support extends AbstractPaymentMethodType
{
    protected $name = 'umbra_monero';

    public function initialize()
    {
        $this->settings = get_option('woocommerce_umbra_monero_settings', []);
    }

    public function is_active()
    {
        $gateways = WC()->payment_gateways() ? WC()->payment_gateways()->payment_gateways() : [];
        return isset($gateways[$this->name]) && $gateways[$this->name]->is_available();
    }

    public function get_payment_method_script_handles()
    {
        $handle = 'umbra-monero-blocks';
        wp_register_script(
            $handle,
            plugins_url('assets/blocks.js', UMBRA_WC_PLUGIN_FILE),
            ['wc-blocks-registry', 'wp-element', 'wp-html-entities', 'wp-i18n'],
            UMBRA_WC_VERSION,
            true
        );
        return [$handle];
    }

    public function get_payment_method_data()
    {
        return [
            'title'       => isset($this->settings['title']) ? $this->settings['title'] : __('Monero (XMR)', 'umbra-monero'),
            'description' => isset($this->settings['description']) ? $this->settings['description'] : '',
            'supports'    => ['products'],
        ];
    }
}
