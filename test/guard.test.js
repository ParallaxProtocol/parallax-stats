var test = require('node:test');
var assert = require('node:assert');

process.env.WS_SECRET = 'private-a|private-b';
process.env.PUBLIC_SECRET = 'open';
process.env.TRUSTED_PROXIES = '10.0.0.1';

var guard = require('../lib/guard');

function spark(remote, xff)
{
	return { remote: { ip: remote }, headers: (xff ? { 'x-forwarded-for': xff } : {}) };
}

test('authenticate maps secrets to trust levels', function () {
	assert.strictEqual(guard.authenticate('private-a'), 'trusted');
	assert.strictEqual(guard.authenticate('private-b'), 'trusted');
	assert.strictEqual(guard.authenticate('open'), 'public');
	assert.strictEqual(guard.authenticate('wrong'), null);
	assert.strictEqual(guard.authenticate(''), null);
	assert.strictEqual(guard.authenticate(undefined), null);
});

test('clientIP ignores forwarding headers from untrusted peers', function () {
	assert.strictEqual(guard.clientIP(spark('1.2.3.4', '9.9.9.9')), '1.2.3.4');
	assert.strictEqual(guard.clientIP(spark('::ffff:1.2.3.4')), '1.2.3.4');
});

test('clientIP takes the right-most non-proxy hop behind a trusted proxy', function () {
	assert.strictEqual(guard.clientIP(spark('10.0.0.1', '5.5.5.5')), '5.5.5.5');
	// A client-supplied hop left of the real one is ignored
	assert.strictEqual(guard.clientIP(spark('10.0.0.1', '6.6.6.6, 5.5.5.5')), '5.5.5.5');
	assert.strictEqual(guard.clientIP(spark('10.0.0.1', '5.5.5.5, 10.0.0.1')), '5.5.5.5');
	// Garbage stops the walk and falls back to the proxy
	assert.strictEqual(guard.clientIP(spark('10.0.0.1', 'not-an-ip')), '10.0.0.1');
});

test('RateLimiter allows a fixed number per minute per key', function () {
	var limiter = new guard.RateLimiter(2);

	assert.ok(limiter.allow('a', 1000));
	assert.ok(limiter.allow('a', 1001));
	assert.ok(!limiter.allow('a', 1002));
	assert.ok(limiter.allow('b', 1002));
	assert.ok(limiter.allow('a', 1000 + 60 * 1000 + 1));
});

test('TokenBucket refills over time', function () {
	var bucket = new guard.TokenBucket(1, 2);
	var now = bucket.updated;

	assert.ok(bucket.take(now));
	assert.ok(bucket.take(now));
	assert.ok(!bucket.take(now));
	assert.ok(bucket.take(now + 1000));
});

test('cleanId accepts plain names and rejects the rest', function () {
	assert.strictEqual(guard.cleanId('my-node 1'), 'my-node 1');
	assert.strictEqual(guard.cleanId('<script>'), null);
	assert.strictEqual(guard.cleanId('a:b'), null);
	assert.strictEqual(guard.cleanId(''), null);
	assert.strictEqual(guard.cleanId('x'.repeat(65)), 'x'.repeat(64));
	assert.strictEqual(guard.cleanId({}), null);
});

test('cleanInfo strips control characters and unknown fields', function () {
	var info = guard.cleanInfo({ name: 'a‮b\u0000c', node: 'Parallax/v2.1.0', extra: 'x', port: 99999 });

	assert.strictEqual(info.name, 'abc');
	assert.strictEqual(info.port, 65535);
	assert.strictEqual(info.extra, undefined);
	assert.strictEqual(guard.cleanInfo('nope'), null);
});

var HASH = '0x' + 'ab'.repeat(32);

test('cleanBlock compacts transactions and validates fields', function () {
	var block = guard.cleanBlock({
		number: 42,
		hash: HASH,
		difficulty: '2984345036800',
		totalDifficulty: 123,
		transactions: [{ hash: HASH }, { hash: HASH }],
		uncles: [],
		miner: 'not an address'
	});

	assert.strictEqual(block.number, 42);
	assert.strictEqual(block.txCount, 2);
	assert.deepStrictEqual(block.transactions, []);
	assert.strictEqual(block.totalDifficulty, '123');
	assert.strictEqual(block.miner, '0x' + '0'.repeat(40));

	assert.strictEqual(guard.cleanBlock({ number: 1, hash: 'nope', difficulty: '1', totalDifficulty: '1' }), null);
	assert.strictEqual(guard.cleanBlock({ number: -1, hash: HASH, difficulty: '1', totalDifficulty: '1' }), null);
	assert.strictEqual(guard.cleanBlock({ number: 1, hash: HASH, difficulty: '1e9', totalDifficulty: '1' }), null);
});

test('cleanHistory keeps at most 50 valid blocks', function () {
	var blocks = [];

	for(var i = 1; i <= 80; i++)
		blocks.push({ number: i, hash: HASH, difficulty: '1', totalDifficulty: String(i) });

	blocks.push({ bogus: true });

	assert.strictEqual(guard.cleanHistory(blocks).length, 50);
	assert.strictEqual(guard.cleanHistory('x'), null);
});

test('cleanStats clamps numbers and coerces flags', function () {
	var stats = guard.cleanStats({ peers: -5, peerLatency: '213', syncing: 'yes', mining: true, hashrate: 'NaN' });

	assert.strictEqual(stats.peers, 0);
	assert.strictEqual(stats.peerLatency, 213);
	assert.strictEqual(stats.syncing, false);
	assert.strictEqual(stats.mining, true);
	assert.strictEqual(stats.hashrate, 0);
});
