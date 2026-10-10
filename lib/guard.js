// Guards for a dashboard whose reporting secret is public: settings,
// client address resolution, rate limiting and sanitizing of everything
// nodes send. Nodes are untrusted input unless they log in with a
// private secret.

var net = require('net');
var _ = require('lodash');

function splitList(value)
{
	return _.filter(String(value || '').split(/[|,]/).map(_.trim), function (item) {
		return item.length > 0;
	});
}

function intSetting(name, fallback)
{
	var value = parseInt(process.env[name], 10);

	return (isNaN(value) || value < 0 ? fallback : value);
}

// Settings, all from the environment.
//
//   WS_SECRET          private secrets ('|' separated); nodes using one are trusted
//   PUBLIC_SECRET      secret published on the page; nodes using it are untrusted
//   TRUSTED_PROXIES    reverse proxy addresses allowed to set X-Forwarded-For
//   MAX_NODES          total nodes tracked, connected or recently seen;
//                      trusted nodes are always admitted
//   MAX_NODES_PER_IP   untrusted names per address, connected or recently seen
//   CONN_PER_MINUTE    new connections per address per minute
//   NAME_HOLD_MINUTES  how long a disconnected name stays bound to its address
var settings = {
	privateSecrets: splitList(process.env.WS_SECRET),
	publicSecret: _.trim(process.env.PUBLIC_SECRET || ''),
	trustedProxies: splitList(process.env.TRUSTED_PROXIES),
	maxNodes: intSetting('MAX_NODES', 1000),
	maxNodesPerIP: intSetting('MAX_NODES_PER_IP', 3),
	connPerMinute: intSetting('CONN_PER_MINUTE', 10),
	nameHoldMs: intSetting('NAME_HOLD_MINUTES', 60) * 60 * 1000,

	// Largest websocket frame accepted. A 50 block history report is the
	// biggest message, and it is compacted to a few kB once sanitized.
	maxMessageBytes: intSetting('MAX_MESSAGE_BYTES', 4 * 1024 * 1024),

	// Messages per connection: a token bucket refilled at this rate
	msgPerSecond: 5,
	msgBurst: 50
};

// A public secret must never double as a private one, or every node
// using the published value would be trusted.
settings.privateSecrets = _.without(settings.privateSecrets, settings.publicSecret);

// authenticate maps a login secret to a trust level: 'trusted',
// 'public', or null when it matches neither.
function authenticate(secret)
{
	if( !_.isString(secret) || secret.length === 0 )
		return null;

	if( settings.privateSecrets.indexOf(secret) >= 0 )
		return 'trusted';

	if( settings.publicSecret.length > 0 && secret === settings.publicSecret )
		return 'public';

	return null;
}

function normalizeIP(ip)
{
	ip = String(ip || '');

	if( ip.indexOf('::ffff:') === 0 && net.isIPv4(ip.substr(7)) )
		return ip.substr(7);

	return ip;
}

// clientIP returns the address a spark connected from. Forwarding
// headers are honored only when the socket peer is a configured proxy,
// and then the right-most address not belonging to a proxy wins, since
// anything left of it was supplied by the client.
function clientIP(spark)
{
	var peer = normalizeIP(spark.remote && spark.remote.ip);

	if( settings.trustedProxies.indexOf(peer) < 0 )
		return peer;

	var header = spark.headers && spark.headers['x-forwarded-for'];
	var hops = _.map(splitList(header), normalizeIP);

	for(var i = hops.length - 1; i >= 0; i--)
	{
		if( !net.isIP(hops[i]) )
			break;

		if( settings.trustedProxies.indexOf(hops[i]) < 0 )
			return hops[i];
	}

	return peer;
}

// RateLimiter counts events per key in a sliding one minute window.
function RateLimiter(perMinute)
{
	this.perMinute = perMinute;
	this.hits = {};
}

RateLimiter.prototype.allow = function(key, now)
{
	now = now || _.now();

	var cutoff = now - 60 * 1000;
	var hits = _.filter(this.hits[key] || [], function (t) { return t > cutoff; });

	if( hits.length >= this.perMinute )
	{
		this.hits[key] = hits;
		return false;
	}

	hits.push(now);
	this.hits[key] = hits;

	return true;
}

RateLimiter.prototype.prune = function(now)
{
	var cutoff = (now || _.now()) - 60 * 1000;

	_.forEach(_.keys(this.hits), function (key) {
		this.hits[key] = _.filter(this.hits[key], function (t) { return t > cutoff; });

		if( this.hits[key].length === 0 )
			delete this.hits[key];
	}.bind(this));
}

// TokenBucket limits messages on a single connection.
function TokenBucket(rate, burst)
{
	this.rate = rate;
	this.burst = burst;
	this.tokens = burst;
	this.updated = _.now();
}

TokenBucket.prototype.take = function(now)
{
	now = now || _.now();

	this.tokens = Math.min(this.burst, this.tokens + (now - this.updated) / 1000 * this.rate);
	this.updated = now;

	if( this.tokens < 1 )
		return false;

	this.tokens -= 1;

	return true;
}

// Sanitizers. Each returns a fresh object holding only known fields of
// the expected type, or null when the input is unusable.

// cleanString keeps printable text: control and bidi override
// characters are dropped and the length is capped.
function cleanString(value, max)
{
	if( !_.isString(value) && !_.isNumber(value) )
		return '';

	return String(value)
		.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
		.trim()
		.substr(0, max);
}

function cleanInt(value, min, max, fallback)
{
	var n = Number(value);

	if( !_.isFinite(n) )
		return fallback;

	return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanNumber(value, min, max, fallback)
{
	var n = Number(value);

	if( !_.isFinite(n) )
		return fallback;

	return Math.min(max, Math.max(min, n));
}

function cleanHash(value)
{
	return (_.isString(value) && /^0x[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null);
}

function cleanAddress(value)
{
	return (_.isString(value) && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : '0x0000000000000000000000000000000000000000');
}

// cleanBigNumber keeps a non-negative integer as a decimal string, as
// difficulties overflow JavaScript numbers.
function cleanBigNumber(value)
{
	var s = (_.isNumber(value) && _.isFinite(value) ? Math.max(0, Math.round(value)).toLocaleString('fullwide', { useGrouping: false }) : String(value));

	return (/^[0-9]{1,78}$/.test(s) ? s.replace(/^0+(?=.)/, '') : null);
}

var MAX_BLOCK_NUMBER = Math.pow(2, 48);

function cleanId(value)
{
	var id = cleanString(value, 64);

	// Names end up in shell commands people copy, in tooltips and as
	// lookup keys, so keep them to a conservative character set.
	if( !/^[A-Za-z0-9][A-Za-z0-9 ._\-()\[\]#+]{0,63}$/.test(id) )
		return null;

	return id;
}

function cleanInfo(info)
{
	if( !_.isPlainObject(info) )
		return null;

	return {
		name: cleanString(info.name, 64),
		node: cleanString(info.node, 128),
		port: cleanInt(info.port, 0, 65535, 0),
		net: cleanString(info.net, 32),
		protocol: cleanString(info.protocol, 128),
		api: cleanString(info.api, 32),
		os: cleanString(info.os, 32),
		os_v: cleanString(info.os_v, 32),
		client: cleanString(info.client, 32),
		canUpdateHistory: info.canUpdateHistory === true
	};
}

// cleanBlock compacts a reported block. Transaction and uncle lists are
// replaced by empty arrays plus counts: nothing downstream needs the
// hashes, and keeping them would let a node fill memory and every
// viewer's connection with arbitrarily large blocks.
function cleanBlock(block)
{
	if( !_.isPlainObject(block) )
		return null;

	var number = Number(block.number);

	if( !Number.isInteger(number) || number < 0 || number > MAX_BLOCK_NUMBER )
		return null;

	var hash = cleanHash(block.hash);
	var difficulty = cleanBigNumber(block.difficulty);
	var totalDifficulty = cleanBigNumber(block.totalDifficulty);

	if( hash === null || difficulty === null || totalDifficulty === null )
		return null;

	var txCount = (_.isArray(block.transactions) ? block.transactions.length : cleanInt(block.txCount, 0, 1e7, 0));
	var uncleCount = (_.isArray(block.uncles) ? block.uncles.length : cleanInt(block.uncleCount, 0, 100, 0));

	return {
		number: number,
		hash: hash,
		parentHash: cleanHash(block.parentHash) || '0x' + _.repeat('0', 64),
		timestamp: cleanInt(block.timestamp, 0, MAX_BLOCK_NUMBER, 0),
		miner: cleanAddress(block.miner),
		gasUsed: cleanInt(block.gasUsed, 0, Number.MAX_SAFE_INTEGER, 0),
		gasLimit: cleanInt(block.gasLimit, 0, Number.MAX_SAFE_INTEGER, 0),
		difficulty: difficulty,
		totalDifficulty: totalDifficulty,
		transactionsRoot: cleanHash(block.transactionsRoot) || '',
		stateRoot: cleanHash(block.stateRoot) || '',
		sha3Uncles: cleanHash(block.sha3Uncles) || '',
		transactions: [],
		txCount: Math.min(txCount, 1e7),
		uncles: [],
		uncleCount: Math.min(uncleCount, 100)
	};
}

function cleanHistory(history)
{
	if( !_.isArray(history) )
		return null;

	// Nodes answer a history request with at most 50 blocks
	return _(history).take(50).map(cleanBlock).compact().value();
}

function cleanStats(stats)
{
	if( !_.isPlainObject(stats) )
		return null;

	return {
		active: stats.active !== false,
		mining: stats.mining === true,
		syncing: stats.syncing === true,
		hashrate: cleanNumber(stats.hashrate, 0, 1e21, 0),
		peers: cleanInt(stats.peers, 0, 100000, 0),
		gasPrice: cleanNumber(stats.gasPrice, 0, 1e30, 0),
		uptime: cleanInt(stats.uptime, 0, 100, 100),
		peerLatency: cleanInt(stats.peerLatency, 0, 600000, 0)
	};
}

function cleanPending(stats)
{
	if( !_.isPlainObject(stats) )
		return null;

	return { pending: cleanInt(stats.pending, 0, 1e9, 0) };
}

function cleanLatency(latency)
{
	return cleanInt(latency, 0, 600000, 0);
}

module.exports = {
	settings: settings,
	authenticate: authenticate,
	clientIP: clientIP,
	RateLimiter: RateLimiter,
	TokenBucket: TokenBucket,
	cleanId: cleanId,
	cleanInfo: cleanInfo,
	cleanBlock: cleanBlock,
	cleanHistory: cleanHistory,
	cleanStats: cleanStats,
	cleanPending: cleanPending,
	cleanLatency: cleanLatency
};
