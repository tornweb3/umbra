<?php
/**
 * Plugin Name: Umbra Monero Payments for WooCommerce
 * Description: Accept Monero (XMR) non-custodially. Buyers pay on a hosted Umbra checkout; orders are completed automatically when the payment confirms on-chain.
 * Version:     0.1.0
 * Author:      Umbra
 * Plugin URI:  https://www.umbra.international
 * License:     GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: umbra-monero
 * Requires PHP: 7.4
 * Requires at least: 6.0
 * WC requires at least: 7.0
 *
 * The store never holds keys or funds: Umbra mints an invoice, the buyer pays
 * the subaddress from their own wallet, and Umbra posts a signed webhook back
 * here at 0-conf (payment_detected) and at the confirmation threshold
 * (payment_confirmed), which is what completes the order.
 */

/*
 * Copyright (C) 2026 Umbra
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 2 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details. A copy ships with this plugin in LICENSE.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('UMBRA_WC_VERSION', '0.1.0');
define('UMBRA_WC_PLUGIN_FILE', __FILE__);

// Currencies the Umbra API can price an invoice in (see gateway/src/rates.ts).
const UMBRA_WC_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'NZD', 'SEK', 'PLN', 'BRL', 'INR'];

add_action('before_woocommerce_init', function () {
    if (class_exists(\Automattic\WooCommerce\Utilities\FeaturesUtil::class)) {
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('custom_order_tables', __FILE__, true);
        \Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility('cart_checkout_blocks', __FILE__, true);
    }
});

add_action('plugins_loaded', function () {
    if (!class_exists('WC_Payment_Gateway')) {
        add_action('admin_notices', function () {
            echo '<div class="notice notice-error"><p>' .
                esc_html__('Umbra Monero Payments requires WooCommerce to be installed and active.', 'umbra-monero') .
                '</p></div>';
        });
        return;
    }
    require_once __DIR__ . '/includes/class-wc-gateway-umbra.php';

    add_filter('woocommerce_payment_gateways', function ($gateways) {
        $gateways[] = 'WC_Gateway_Umbra';
        return $gateways;
    });

    // Umbra posts webhooks to /?wc-api=umbra_monero (WooCommerce's callback route).
    add_action('woocommerce_api_umbra_monero', function () {
        (new WC_Gateway_Umbra())->handle_webhook();
    });
});

// Classic checkout registers the gateway above; the block checkout needs its
// own registration, which is this small adapter plus assets/blocks.js.
add_action('woocommerce_blocks_loaded', function () {
    if (!class_exists(\Automattic\WooCommerce\Blocks\Payments\Integrations\AbstractPaymentMethodType::class)) {
        return;
    }
    require_once __DIR__ . '/includes/class-umbra-blocks-support.php';
    add_action(
        'woocommerce_blocks_payment_method_type_registration',
        function (\Automattic\WooCommerce\Blocks\Payments\PaymentMethodRegistry $registry) {
            $registry->register(new Umbra_Blocks_Support());
        }
    );
});

add_filter('plugin_action_links_' . plugin_basename(__FILE__), function ($links) {
    $url = admin_url('admin.php?page=wc-settings&tab=checkout&section=umbra_monero');
    array_unshift($links, '<a href="' . esc_url($url) . '">' . esc_html__('Settings', 'umbra-monero') . '</a>');
    return $links;
});
