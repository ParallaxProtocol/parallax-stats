// sparkColorMaps holds the bar colors per chart. Block times (seconds)
// are graded against the target interval; every other chart is plain.
var sparkColorMaps = (function() {
	var t = targetBlockTime;
	var blocktime = {};

	blocktime['0:' + t/2] = '#10a0de';
	blocktime[t/2 + ':' + t*1.5] = '#7bcc3a';
	blocktime[t*1.5 + ':' + t*3] = '#FFD162';
	blocktime[t*3 + ':' + t*6] = '#ff8a00';
	blocktime[t*6 + ':'] = '#F74B4B';

	return {
		blocktime: $.range_map(blocktime),
		plain: $.range_map({ ':': '#10a0de' })
	};
})();

(function() {
	$('body').on('mouseenter', '[data-toggle="tooltip"]', function( event ) {
		$(this).tooltip('show');
	}).on('mouseleave', '[data-toggle="tooltip"]', function( event ) {
		$(this).tooltip('hide');
	});

	$.fn.sparkline.defaults.bar.height = 63;
	$.fn.sparkline.defaults.bar.barWidth = 6;

	if( $('body').width() < 600 )
		$.fn.sparkline.defaults.bar.barWidth = 4;
	else if( $('body').width() < 1200 )
		$.fn.sparkline.defaults.bar.barWidth = 5;
	$.fn.sparkline.defaults.bar.barSpacing = 1;
	$.fn.sparkline.defaults.bar.tooltipClassname = 'jqstooltip';
	$.fn.sparkline.defaults.bar.tooltipOffsetX = 0;
	$.fn.sparkline.defaults.bar.tooltipFormat = $.spformat('<div class="tooltip-arrow"></div><div class="tooltip-inner">{{prefix}}{{value}} {{suffix}}</div>');

	moment.relativeTimeThreshold('s', 60);
	moment.relativeTimeThreshold('m', 60);
	moment.relativeTimeThreshold('h', 24);
	moment.relativeTimeThreshold('d', 28);
	moment.relativeTimeThreshold('M', 12);

})();
