var _ = require('lodash');
var logger = require('./lib/utils/logger');
var chalk = require('chalk');
var http = require('http');
var guard = require('./lib/guard');
var settings = guard.settings;

// Init secrets. WS_SECRET holds private secrets whose nodes are trusted,
// PUBLIC_SECRET the secret published on the page for everyone else.
if( settings.privateSecrets.length === 0 )
{
	try {
		var tmp_secret_json = require('./ws_secret.json');

		settings.privateSecrets = _.without(_.filter(_.values(tmp_secret_json), function (secret) {
			return _.isString(secret) && secret.length > 0;
		}), settings.publicSecret);
	}
	catch (e) {}
}

if( settings.privateSecrets.length === 0 && settings.publicSecret.length === 0 )
{
	console.error("Neither WS_SECRET nor PUBLIC_SECRET is set");
	process.exit(1);
}

var banned   = require('./lib/utils/config').banned;
var reserved = require('./lib/utils/config').reserved;

// Init socket vars
var Primus = require('primus');
var api;
var client;
var server;

// Init http server
if( process.env.NODE_ENV !== 'production' )
{
	var app = require('./lib/express');
	server = http.createServer(app);
}
else
	server = http.createServer();


// Init API Socket connection
api = new Primus(server, {
	transformer: 'websockets',
	pathname: '/api',
	parser: 'JSON',
	maxLength: settings.maxMessageBytes
});

api.plugin('emit', require('primus-emit'));
api.plugin('spark-latency', require('primus-spark-latency'));


// Init Client Socket connection
client = new Primus(server, {
	transformer: 'websockets',
	pathname: '/primus',
	parser: 'JSON',
	maxLength: 64 * 1024
});

client.plugin('emit', require('primus-emit'));


// Init external API
external = new Primus(server, {
	transformer: 'websockets',
	pathname: '/external',
	parser: 'JSON',
	maxLength: 64 * 1024
});

external.plugin('emit', require('primus-emit'));

// Init collections
var Collection = require('./lib/collection');
var Nodes = new Collection(external);

Nodes.setChartsCallback(function (err, charts)
{
	if(err !== null)
	{
		console.error('COL', 'CHR', 'Charts error:', err);
	}
	else
	{
		client.write({
			action: 'charts',
			data: charts
		});
	}
});

var connectionLimiter = new guard.RateLimiter(settings.connPerMinute);

setInterval(function () {
	connectionLimiter.prune();
}, 60 * 1000);


// Init API Socket events
api.on('connection', function (spark)
{
	var ip = guard.clientIP(spark);

	if( banned.indexOf(ip) >= 0 || !connectionLimiter.allow(ip) )
	{
		console.warn('API', 'CON', 'Refused:', ip);
		spark.end(undefined, { reconnect: false });

		return;
	}

	console.info('API', 'CON', 'Open:', ip);

	// The node this connection logged in as. Every report is attributed
	// to it, whatever id the message itself claims.
	var nodeId = null;
	var bucket = new guard.TokenBucket(settings.msgPerSecond, settings.msgBurst);

	// on registers a handler that enforces the per-connection message
	// rate and, except for the login itself, a completed login.
	function on(event, handler)
	{
		spark.on(event, function (data)
		{
			if( !bucket.take() )
			{
				console.warn('API', 'CON', 'Message rate exceeded, closing:', nodeId || ip);
				spark.end(undefined, { reconnect: true });

				return;
			}

			if( event !== 'hello' && nodeId === null )
				return;

			handler(data || {});
		});
	}

	on('hello', function (data)
	{
		if( nodeId !== null )
			return;

		var level = guard.authenticate(data.secret);
		var id = guard.cleanId(data.id);
		var info = guard.cleanInfo(data.info);

		if( level === null || id === null || info === null || reserved.indexOf(id) >= 0 )
		{
			console.error('API', 'CON', 'Closed - wrong auth or invalid login from', ip);
			spark.end(undefined, { reconnect: false });

			return;
		}

		Nodes.add({
			id: id,
			info: info,
			ip: ip,
			spark: spark.id,
			latency: spark.latency || 0,
			trusted: level === 'trusted'
		}, function (err, nodeInfo)
		{
			if(err !== null)
			{
				console.warn('API', 'CON', 'Login refused:', id, ip, err);
				spark.end(undefined, { reconnect: false });

				return;
			}

			nodeId = id;
			spark.emit('ready');

			console.success('API', 'CON', 'Connected:', id, (level === 'trusted' ? '(trusted)' : ''));

			client.write({
				action: 'add',
				data: nodeInfo
			});
		});
	});


	on('block', function (data)
	{
		var block = guard.cleanBlock(data.block);

		if( block === null )
		{
			console.error('API', 'BLK', 'Invalid block from:', nodeId);
			return;
		}

		Nodes.addBlock(nodeId, block, function (err, stats)
		{
			if(err !== null)
			{
				console.error('API', 'BLK', 'Block error:', err);
			}
			else if(stats !== null)
			{
				client.write({
					action: 'block',
					data: stats
				});

				console.success('API', 'BLK', 'Block:', block.number, 'td:', block.totalDifficulty, 'from:', nodeId);

				Nodes.getCharts();
			}
		});
	});


	on('pending', function (data)
	{
		var stats = guard.cleanPending(data.stats);

		if( stats === null )
			return;

		Nodes.updatePending(nodeId, stats, function (err, stats) {
			if(err !== null)
			{
				console.error('API', 'TXS', 'Pending error:', err);
			}

			if(stats !== null)
			{
				client.write({
					action: 'pending',
					data: stats
				});

				console.success('API', 'TXS', 'Pending:', stats.pending, 'from:', nodeId);
			}
		});
	});


	on('stats', function (data)
	{
		var stats = guard.cleanStats(data.stats);

		if( stats === null )
		{
			console.error('API', 'STA', 'Invalid stats from:', nodeId);
			return;
		}

		Nodes.updateStats(nodeId, stats, function (err, stats)
		{
			if(err !== null)
			{
				console.error('API', 'STA', 'Stats error:', err);
			}
			else if(stats !== null)
			{
				client.write({
					action: 'stats',
					data: stats
				});

				console.success('API', 'STA', 'Stats from:', nodeId);
			}
		});
	});


	on('history', function (data)
	{
		var history = guard.cleanHistory(data.history);

		if( history === null )
			return;

		console.success('API', 'HIS', 'Got history from:', nodeId);

		Nodes.addHistory(nodeId, history, function (err, history)
		{
			if(err !== null)
			{
				console.error('COL', 'CHR', 'History error:', err);
			}
			else
			{
				client.write({
					action: 'charts',
					data: history
				});
			}
		});
	});


	on('node-ping', function (data)
	{
		spark.emit('node-pong', {
			clientTime: (_.isString(data.clientTime) ? data.clientTime.substr(0, 64) : null),
			serverTime: _.now()
		});

		console.info('API', 'PIN', 'Ping from:', nodeId);
	});


	on('latency', function (data)
	{
		Nodes.updateLatency(nodeId, guard.cleanLatency(data.latency), function (err, latency)
		{
			if(err !== null)
			{
				console.error('API', 'PIN', 'Latency error:', err);
			}

			if(latency !== null)
			{
				console.info('API', 'PIN', 'Latency:', latency, 'from:', nodeId);
			}
		});

		if( Nodes.requiresUpdate(nodeId) )
		{
			var range = Nodes.getHistory().getHistoryRequestRange();

			spark.emit('history', range);
			console.info('API', 'HIS', 'Asked:', nodeId, 'for history:', range.min, '-', range.max);

			Nodes.askedNodeForHistory(nodeId);
		}
	});


	spark.on('end', function (data)
	{
		Nodes.inactive(spark.id, function (err, stats)
		{
			if(err !== null)
			{
				console.error('API', 'CON', 'Connection end error:', err);
			}
			else
			{
				client.write({
					action: 'inactive',
					data: stats
				});

				console.warn('API', 'CON', 'Connection with:', nodeId || ip, 'ended:', data);
			}
		});
	});
});



client.on('connection', function (clientSpark)
{
	clientSpark.on('ready', function (data)
	{
		clientSpark.emit('init', {
			nodes: Nodes.all()
		});

		Nodes.getCharts();
	});

	clientSpark.on('client-pong', function (data)
	{
		var serverTime = _.get(data, "serverTime", 0);
		var latency = Math.ceil( (_.now() - serverTime) / 2 );

		clientSpark.emit('client-latency', { latency: latency });
	});
});

var latencyTimeout = setInterval( function ()
{
	client.write({
		action: 'client-ping',
		data: {
			serverTime: _.now()
		}
	});
}, 5000);


// Cleanup old inactive nodes
var nodeCleanupTimeout = setInterval( function ()
{
	client.write({
		action: 'init',
		data: Nodes.all()
	});

	Nodes.getCharts();

}, 1000*60*60);

server.listen(process.env.PORT || 3000);

module.exports = server;
