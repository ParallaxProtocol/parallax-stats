var _ = require('lodash');
var Blockchain = require('./history');
var Node = require('./node');
var settings = require('./guard').settings;

var Collection = function Collection(externalAPI)
{
	this._items = [];
	this._blockchain = new Blockchain();
	this._askedForHistory = false;
	this._askedForHistoryTime = 0;
	this._askedForHistoryId = null;
	this._debounced = null;
	this._externalAPI = externalAPI;
	this._highestBlock = 0;

	return this;
}

Collection.prototype.setupSockets = function()
{
	this._externalAPI.on('connection', function (spark)
	{
		this._externalAPI.on('latestBlock', function (data)
		{
			spark.emit('latestBlock', {
				number: this._highestBlock
			});
		});
	});
}

// add registers a node login. Untrusted logins cannot take over a name
// that is connected, or was recently connected, from another address,
// nor any name a trusted node holds, and are capped per address and in
// total. callback(err, info) reports a refusal through err.
Collection.prototype.add = function(data, callback)
{
	var existing = this.getNode({ id: data.id });
	var now = _.now();

	if( existing && !data.trusted )
	{
		if( existing.trusted )
			return callback('Name is reserved by a trusted node', null);

		if( existing.ip !== data.ip )
		{
			if( existing.stats.active )
				return callback('Name is in use from another address', null);

			if( now - existing.uptime.lastUpdate < settings.nameHoldMs )
				return callback('Name was recently used from another address', null);
		}
	}

	if( !data.trusted && !existing )
	{
		// Bound what one address can hold, connected or not, so cycling
		// through names cannot fill the node list. Its oldest
		// disconnected name makes room for a new one.
		var fromSameIP = _.filter(this._items, function (node) {
			return node.ip === data.ip && !node.trusted;
		});

		if( fromSameIP.length >= settings.maxNodesPerIP )
		{
			var stale = _(fromSameIP)
				.filter(function (node) { return !node.stats.active; })
				.sortBy('uptime.lastUpdate')
				.first();

			if( !stale )
				return callback('Too many nodes from this address', null);

			_.pull(this._items, stale);
		}
	}

	if( !existing )
	{
		this.removeOldNodes();

		if( this._items.length >= settings.maxNodes )
		{
			if( !data.trusted )
				return callback('Node limit reached', null);

			// A full list must not lock out the operator's own nodes.
			// Make room by dropping the longest disconnected untrusted
			// node, or go over the cap if every untrusted node is
			// connected: trusted nodes are few and run by the operator.
			var stale = _(this._items)
				.filter(function (node) { return !node.trusted && !node.stats.active; })
				.sortBy('uptime.lastUpdate')
				.first();

			if( stale )
				_.pull(this._items, stale);
		}
	}

	var node = this.getNodeOrNew({ id : data.id }, data);
	node.setInfo(data, callback);
}

// hasTrusted reports whether a trusted node is connected. While one is,
// only trusted nodes may introduce new block heights and answer history
// requests.
Collection.prototype.hasTrusted = function()
{
	return _.some(this._items, function (node) {
		return node.trusted && node.stats.active;
	});
}

Collection.prototype.update = function(id, stats, callback)
{
	var node = this.getNode({ id: id });

	if (!node)
	{
		callback('Node not found', null);
	}
	else
	{
		// this._blockchain.clean(this.getBestBlockFromItems());

		var block = this._blockchain.add(stats.block, id, node.trusted);

		if (!block)
		{
			callback('Block data wrong', null);
		}
		else
		{
			var propagationHistory = this._blockchain.getNodePropagation(id);

			stats.block.arrived = block.block.arrived;
			stats.block.received = block.block.received;
			stats.block.propagation = block.block.propagation;

			node.setStats(stats, propagationHistory, callback);
		}
	}
}

Collection.prototype.addBlock = function(id, stats, callback)
{
	var node = this.getNode({ id: id });

	if (!node)
	{
		callback('Node not found', null);
	}
	else
	{
		this._blockchain.setTrustedOnly(this.hasTrusted());

		var block = this._blockchain.add(stats, id, node.trusted);
		var propagationHistory = this._blockchain.getNodePropagation(id);

		if (!block)
		{
			// Not recorded in the shared history (genesis, or a height
			// no trusted node has reported), but still the node's head.
			stats.arrived = stats.received = _.now();
			stats.propagation = 0;
			stats.time = 0;
		}
		else
		{
			stats.arrived = block.block.arrived;
			stats.received = block.block.received;
			stats.propagation = block.block.propagation;

			if(block.block.number > this._highestBlock)
			{
				this._highestBlock = block.block.number;
				this._externalAPI.write({
					action:"lastBlock",
					number: this._highestBlock
				});
			}
		}

		node.setBlock(stats, propagationHistory, callback);
	}
}

Collection.prototype.updatePending = function(id, stats, callback)
{
	var node = this.getNode({ id: id });

	if (!node)
		return false;

	node.setPending(stats, callback);
}

Collection.prototype.updateStats = function(id, stats, callback)
{
	var node = this.getNode({ id: id });

	if (!node)
	{
		callback('Node not found', null);
	}
	else
	{
		node.setBasicStats(stats, callback);
	}
}

// TODO: Async series
Collection.prototype.addHistory = function(id, blocks, callback)
{
	var node = this.getNode({ id: id });

	if (!node)
	{
		callback('Node not found', null)
	}
	else if (id !== this._askedForHistoryId)
	{
		// Only the node asked may fill the shared history
		callback('History was not requested from this node', null);
		return;
	}
	else
	{
		blocks = blocks.reverse();

		this._blockchain.setTrustedOnly(this.hasTrusted());

		for (var i = 0; i <= blocks.length - 1; i++)
		{
			this._blockchain.add(blocks[i], id, node.trusted, true);
		};

		this.getCharts();
	}

	this._askedForHistoryId = null;
	this.askedForHistory(false);
}

Collection.prototype.updateLatency = function(id, latency, callback)
{
	var node = this.getNode({ id: id });

	if (!node)
		return false;

	node.setLatency(latency, callback);
}

Collection.prototype.inactive = function(id, callback)
{
	var node = this.getNode({ spark: id });

	if (!node)
	{
		callback('Node not found', null);
	}
	else
	{
		node.setState(false);
		callback(null, node.getStats());
	}
}

Collection.prototype.getIndex = function(search)
{
	return _.findIndex(this._items, search);
}

Collection.prototype.getNode = function(search)
{
	var index = this.getIndex(search);

	if(index >= 0)
		return this._items[index];

	return false;
}

Collection.prototype.getNodeByIndex = function(index)
{
	if(this._items[index])
		return this._items[index];

	return false;
}

Collection.prototype.getIndexOrNew = function(search, data)
{
	var index = this.getIndex(search);

	return (index >= 0 ? index : this._items.push(new Node(data)) - 1);
}

Collection.prototype.getNodeOrNew = function(search, data)
{
	return this.getNodeByIndex(this.getIndexOrNew(search, data));
}

// all returns the public view of every node, as sent to viewers.
Collection.prototype.all = function()
{
	this.removeOldNodes();

	return _.map(this._items, function (node) {
		return node.getInfo();
	});
}

Collection.prototype.removeOldNodes = function()
{
	var deleteList = []

	for(var i = this._items.length - 1; i >= 0; i--)
	{
		if( this._items[i].isInactiveAndOld() )
		{
			deleteList.push(i);
		}
	}

	if(deleteList.length > 0)
	{
		for(var i = 0; i < deleteList.length; i++)
		{
			this._items.splice(deleteList[i], 1);
		}
	}
}

Collection.prototype.blockPropagationChart = function()
{
	return this._blockchain.getBlockPropagation();
}

Collection.prototype.getUncleCount = function()
{
	return this._blockchain.getUncleCount();
}

Collection.prototype.setChartsCallback = function(callback)
{
	this._blockchain.setCallback(callback);
}

Collection.prototype.getCharts = function()
{
	this.getChartsDebounced();
}

Collection.prototype.getChartsDebounced = function()
{
	var self = this;

	if( this._debounced === null) {
		this._debounced = _.debounce(function(){
			self._blockchain.getCharts();
		}, 1000, {
			leading: false,
			maxWait: 5000,
			trailing: true
		});
	}

	this._debounced();
}

Collection.prototype.getHistory = function()
{
	return this._blockchain;
}

Collection.prototype.getBestBlockFromItems = function()
{
	return Math.max(this._blockchain.bestBlockNumber(), _.result(_.max(this._items, function(item) {
		// return ( !item.trusted ? 0 : item.stats.block.number );
		return ( item.stats.block.number );
	}), 'stats.block.number', 0));
}

Collection.prototype.canNodeUpdate = function(id)
{
	var node = this.getNode({id: id});

	if(!node)
		return false;

	if(this.hasTrusted() && !node.trusted)
		return false;

	if(node.canUpdate())
	{
		var diff = node.getBlockNumber() - this._blockchain.bestBlockNumber();

		return Boolean(diff >= 0);
	}

	return false;
}

Collection.prototype.requiresUpdate = function(id)
{
	return ( this.canNodeUpdate(id) && this._blockchain.requiresUpdate() && (!this._askedForHistory || _.now() - this._askedForHistoryTime > 2*60*1000) );
}

Collection.prototype.askedNodeForHistory = function(id)
{
	this._askedForHistoryId = id;
	this.askedForHistory(true);
}

Collection.prototype.askedForHistory = function(set)
{
	if( !_.isUndefined(set) )
	{
		this._askedForHistory = set;

		if(set === true)
		{
			this._askedForHistoryTime = _.now();
		}
	}

	return (this._askedForHistory || _.now() - this._askedForHistoryTime < 2*60*1000);
}

module.exports = Collection;
