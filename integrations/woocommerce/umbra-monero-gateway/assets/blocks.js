/**
 * Block checkout registration. Deliberately plain ES5 + wp.element.createElement
 * so the plugin ships with no build step: merchants install it as-is.
 */
(function (wc, wp) {
	if (!wc || !wc.wcBlocksRegistry || !wc.wcSettings || !wp || !wp.element) {
		return;
	}
	var settings = wc.wcSettings.getSetting('umbra_monero_data', {});
	var decode = (wp.htmlEntities && wp.htmlEntities.decodeEntities) || function (s) { return s; };
	var title = decode(settings.title || 'Monero (XMR)');
	var description = decode(settings.description || '');

	wc.wcBlocksRegistry.registerPaymentMethod({
		name: 'umbra_monero',
		label: wp.element.createElement('span', null, title),
		ariaLabel: title,
		content: wp.element.createElement('div', null, description),
		edit: wp.element.createElement('div', null, description),
		canMakePayment: function () {
			return true;
		},
		supports: {
			features: settings.supports || ['products'],
		},
	});
})(window.wc, window.wp);
