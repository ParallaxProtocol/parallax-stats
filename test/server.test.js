// Starts the real server and talks to it over raw websockets, the way
// the parallaxd reporter (node/stats/prlstats.go) does.

var test = require('node:test');
var assert = require('node:assert');
var path = require('path');
var spawn = require('child_process').spawn;
var WebSocket = require('ws');

var PORT = 39000 + Math.floor(Math.random() * 1000);
var HASH = '0x' + 'cd'.repeat(32);
var server;

test.before(function () {
	server = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'www')], {
		env: Object.assign({}, process.env, {
			PORT: String(PORT),
			WS_SECRET: 'private',
			PUBLIC_SECRET: 'open',
			MAX_NODES_PER_IP: '2',
			CONN_PER_MINUTE: '1000',
			NODE_ENV: 'production'
		}),
		stdio: 'ignore'
	});

	return waitForPort();
});

test.after(function () {
	server.kill();
});

function waitForPort()
{
	return new Promise(function (resolve, reject) {
		var deadline = Date.now() + 10000;

		(function attempt() {
			var ws = new WebSocket('ws://127.0.0.1:' + PORT + '/primus');

			ws.on('open', function () { ws.close(); resolve(); });
			ws.on('error', function () {
				if( Date.now() > deadline )
					return reject(new Error('server did not start'));

				setTimeout(attempt, 100);
			});
		})();
	});
}

// connect opens a socket and records every decoded message
function connect(pathname, headers)
{
	return new Promise(function (resolve, reject) {
		var ws = new WebSocket('ws://127.0.0.1:' + PORT + pathname, { headers: headers || {} });

		ws.messages = [];
		ws.closed = false;
		ws.on('message', function (raw) {
			var msg = JSON.parse(raw);

			if( typeof msg === 'string' && msg.indexOf('primus::ping::') === 0 )
				return ws.send(JSON.stringify(msg.replace('ping', 'pong')));

			ws.messages.push(msg);
		});
		ws.on('close', function () { ws.closed = true; });
		ws.on('open', function () { resolve(ws); });
		ws.on('error', reject);
	});
}

function emit(ws, event, data)
{
	ws.send(JSON.stringify({ emit: [event, data] }));
}

function waitFor(check, ms)
{
	return new Promise(function (resolve, reject) {
		var deadline = Date.now() + (ms || 3000);

		(function poll() {
			var value = check();

			if( value )
				return resolve(value);

			if( Date.now() > deadline )
				return reject(new Error('timed out'));

			setTimeout(poll, 20);
		})();
	});
}

function sleep(ms)
{
	return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function isReady(ws)
{
	return ws.messages.some(function (m) { return m.emit && m.emit[0] === 'ready'; });
}

async function report(id, secret, headers)
{
	var ws = await connect('/api', headers);

	emit(ws, 'hello', {
		id: id,
		secret: secret,
		info: { name: id, node: 'Parallax/v2.1.0-stable/linux-amd64/go1.27.1', net: '2110', canUpdateHistory: true }
	});

	return ws;
}

// viewNodes fetches the node list a browser would get
async function viewNodes()
{
	var ws = await connect('/primus');

	emit(ws, 'ready');

	var init = await waitFor(function () {
		return ws.messages.find(function (m) { return m.emit && m.emit[0] === 'init'; });
	});

	ws.close();

	return init.emit[1];
}

function findNode(view, id)
{
	return view.nodes.find(function (n) { return n.id === id; });
}

test('a wrong secret is refused', async function () {
	var ws = await report('intruder', 'guess');

	await waitFor(function () { return ws.closed; });
	assert.ok(!isReady(ws));
	assert.strictEqual(findNode(await viewNodes(), 'intruder'), undefined);
});

test('public and private secrets log in with different trust', async function () {
	var pub = await report('public-node', 'open');
	var priv = await report('own-node', 'private');

	await waitFor(function () { return isReady(pub) && isReady(priv); });

	var view = await viewNodes();

	assert.strictEqual(findNode(view, 'own-node').trusted, true);
	assert.ok(view.nodes.some(function (n) { return !n.trusted && /^node-[0-9a-f]{8}$/.test(n.id); }));
	assert.strictEqual(view.config.joinSecret, 'open');

	pub.close();
	priv.close();
});

test('reports are attributed to the logged in node, not the claimed id', async function () {
	var victim = await report('victim', 'private');
	var attacker = await report('attacker', 'open');

	await waitFor(function () { return isReady(victim) && isReady(attacker); });

	emit(victim, 'stats', { id: 'victim', stats: { active: true, peers: 8, peerLatency: 50 } });
	emit(attacker, 'stats', { id: 'victim', stats: { active: true, peers: 0, peerLatency: 9999 } });
	await sleep(300);

	var view = await viewNodes();

	assert.strictEqual(findNode(view, 'victim').stats.peers, 8);
	assert.ok(view.nodes.some(function (n) { return !n.trusted && n.stats.peerLatency === 9999; }));

	victim.close();
	attacker.close();
});

test('viewers never see the names of unverified nodes', async function () {
	var viewer = await connect('/primus');

	emit(viewer, 'ready');

	var pub = await report('hidden-name-xyz', 'open');

	await waitFor(function () { return isReady(pub); });

	emit(pub, 'stats', { stats: { active: true, peers: 3, peerLatency: 40 } });
	emit(pub, 'pending', { stats: { pending: 2 } });
	emit(pub, 'block', { block: { number: 3, hash: HASH, difficulty: '1', totalDifficulty: '3' } });
	await sleep(300);

	var seen = JSON.stringify(viewer.messages) + JSON.stringify(await viewNodes());

	assert.ok(viewer.messages.length > 0);
	assert.ok(seen.indexOf('hidden-name-xyz') < 0);

	viewer.close();
	pub.close();
});

test('messages before login are ignored', async function () {
	var ws = await connect('/api');

	emit(ws, 'block', { id: 'ghost', block: { number: 5, hash: HASH, difficulty: '1', totalDifficulty: '1' } });
	await sleep(300);

	assert.strictEqual(findNode(await viewNodes(), 'ghost'), undefined);
	ws.close();
});

test('forwarding headers from an untrusted peer do not dodge the per-address cap', async function () {
	await sleep(200);

	var a = await report('cap-a', 'open', { 'x-forwarded-for': '1.1.1.1' });
	var b = await report('cap-b', 'open', { 'x-forwarded-for': '2.2.2.2' });
	var c = await report('cap-c', 'open', { 'x-forwarded-for': '3.3.3.3' });

	await waitFor(function () { return c.closed; });
	assert.ok(isReady(a) && isReady(b));
	assert.ok(!isReady(c));

	a.close();
	b.close();
});

test('flooding a connection gets it closed', async function () {
	var ws = await report('flooder', 'private');

	await waitFor(function () { return isReady(ws); });

	for(var i = 0; i < 200; i++)
		emit(ws, 'pending', { stats: { pending: i } });

	await waitFor(function () { return ws.closed; });
});
