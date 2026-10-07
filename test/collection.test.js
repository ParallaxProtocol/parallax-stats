var test = require('node:test');
var assert = require('node:assert');

process.env.MAX_NODES = '5';
process.env.MAX_NODES_PER_IP = '2';
process.env.NAME_HOLD_MINUTES = '60';

var _ = require('lodash');
var guard = require('../lib/guard');
var Collection = require('../lib/collection');

function newCollection()
{
	var nodes = new Collection({ write: function () {} });

	nodes.setChartsCallback(function () {});

	return nodes;
}

function login(nodes, id, ip, trusted)
{
	var result = {};

	nodes.add({ id: id, info: { name: id }, ip: ip, spark: id + '@' + ip, trusted: !!trusted }, function (err, info) {
		result.err = err;
		result.info = info;
	});

	return result;
}

function block(number, hash)
{
	return guard.cleanBlock({
		number: number,
		hash: '0x' + _.padStart(hash || number.toString(16), 64, '0'),
		difficulty: '1000',
		totalDifficulty: String(number * 1000)
	});
}

test('a connected name cannot be taken from another address', function () {
	var nodes = newCollection();

	assert.strictEqual(login(nodes, 'alpha', '1.1.1.1').err, null);
	assert.match(login(nodes, 'alpha', '2.2.2.2').err, /in use/);
	// Reconnecting from the same address is fine
	assert.strictEqual(login(nodes, 'alpha', '1.1.1.1').err, null);
});

test('a disconnected name is held for its address', function () {
	var nodes = newCollection();

	login(nodes, 'alpha', '1.1.1.1');
	nodes.inactive('alpha@1.1.1.1', function () {});

	assert.match(login(nodes, 'alpha', '2.2.2.2').err, /recently used/);

	nodes.getNode({ id: 'alpha' }).uptime.lastUpdate -= 61 * 60 * 1000;

	assert.strictEqual(login(nodes, 'alpha', '2.2.2.2').err, null);
});

test('untrusted logins cannot take a trusted name', function () {
	var nodes = newCollection();

	login(nodes, 'seed', '1.1.1.1', true);
	nodes.inactive('seed@1.1.1.1', function () {});

	assert.match(login(nodes, 'seed', '1.1.1.1').err, /trusted/);
	assert.strictEqual(login(nodes, 'seed', '3.3.3.3', true).err, null);
});

test('one address holds a bounded number of names', function () {
	var nodes = newCollection();

	assert.strictEqual(login(nodes, 'a', '1.1.1.1').err, null);
	assert.strictEqual(login(nodes, 'b', '1.1.1.1').err, null);
	assert.match(login(nodes, 'c', '1.1.1.1').err, /Too many/);

	// A disconnected name from the same address makes room
	nodes.inactive('a@1.1.1.1', function () {});

	assert.strictEqual(login(nodes, 'c', '1.1.1.1').err, null);
	assert.strictEqual(nodes.getNode({ id: 'a' }), false);

	// Trusted nodes are not counted or capped
	assert.strictEqual(login(nodes, 't', '1.1.1.1', true).err, null);
});

test('the total number of nodes is capped', function () {
	var nodes = newCollection();

	for(var i = 0; i < 5; i++)
		assert.strictEqual(login(nodes, 'n' + i, '10.0.0.' + i).err, null);

	assert.match(login(nodes, 'n5', '10.0.0.5').err, /limit/);
});

test('untrusted nodes cannot introduce heights while a trusted node is online', function () {
	var nodes = newCollection();

	login(nodes, 'seed', '1.1.1.1', true);
	login(nodes, 'liar', '2.2.2.2');

	nodes.addBlock('seed', block(100), function () {});
	nodes.addBlock('liar', block(999999), function () {});

	assert.strictEqual(nodes.getHistory().bestBlockNumber(), 100);
	// The liar still shows its own claimed head
	assert.strictEqual(nodes.getNode({ id: 'liar' }).stats.block.number, 999999);

	// Reporting a height the trusted node has seen is recorded
	nodes.addBlock('liar', block(100), function () {});
	assert.ok(_.find(nodes.getHistory().search(100).propagTimes, { node: 'liar' }));
});

test('without a trusted node, everyone can introduce heights', function () {
	var nodes = newCollection();

	login(nodes, 'a', '2.2.2.2');
	nodes.addBlock('a', block(7), function () {});

	assert.strictEqual(nodes.getHistory().bestBlockNumber(), 7);
});

test('history is only accepted from the node it was requested from', function () {
	var nodes = newCollection();
	var err;

	login(nodes, 'a', '1.1.1.1');
	login(nodes, 'b', '2.2.2.2');

	nodes.askedNodeForHistory('a');
	nodes.addHistory('b', [block(5)], function (e) { err = e; });

	assert.match(err, /not requested/);
	assert.strictEqual(nodes.getHistory().bestBlockNumber(), 0);

	nodes.addHistory('a', [block(5)], function () {});
	assert.strictEqual(nodes.getHistory().bestBlockNumber(), 5);
});

test('viewers never see node addresses', function () {
	var nodes = newCollection();

	login(nodes, 'a', '8.8.8.8');

	assert.ok(JSON.stringify(nodes.all()).indexOf('8.8.8.8') < 0);
});
