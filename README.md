Parallax Network Stats
======================

A live dashboard of Parallax nodes: sync state, peer latency, block
propagation, block times, difficulty and hashrate. Nodes report their own
stats over a websocket when started with `--prlstats`, and the dashboard
shows them to every viewer.

Forked from [goerli/ethstats-server](https://github.com/goerli/ethstats-server)
(itself based on [cubedro/eth-netstats](https://github.com/cubedro/eth-netstats))
and adapted for Parallax: 10 minute block times, LAX units, sync state and
median peer latency per node, a responsive layout, and a server that is
safe to run with a public reporting secret.

## Running

Requires Node.js 18 or newer.

```bash
npm install
npx grunt                 # builds the frontend into dist/
WS_SECRET=my-private-secret PUBLIC_SECRET=open-secret npm start
```

The dashboard is served at http://localhost:3000.

## Adding a node

Start `parallaxd` with the dashboard's address and a secret:

```bash
parallaxd --prlstats "my-node:open-secret@stats.example.org"
```

or put the same value in the config file:

```toml
[ParallaxStats]
URL = "my-node:open-secret@stats.example.org"
```

The node dials `wss://<host>/api` and falls back to `ws://`, so it needs
no open ports. The page has an "add your node" section that generates
this command.

## Settings

All settings come from the environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_SECRET` | | Private secrets, separated by `\|`. Nodes using one are **verified**. |
| `PUBLIC_SECRET` | | Secret published on the page. Nodes using it are unverified. |
| `PORT` | `3000` | Listen port |
| `TRUSTED_PROXIES` | | Reverse proxy addresses allowed to set `X-Forwarded-For` |
| `MAX_NODES` | `1000` | Nodes tracked in total, connected or disconnected in the last 4 hours. Verified nodes are always admitted. |
| `MAX_NODES_PER_IP` | `3` | Names one address may hold, connected or recently disconnected (unverified nodes only) |
| `CONN_PER_MINUTE` | `10` | New reporter connections per address per minute |
| `NAME_HOLD_MINUTES` | `60` | How long a disconnected name stays bound to its address |
| `MAX_MESSAGE_BYTES` | `4194304` | Largest reporter message accepted |
| `NODE_ENV` | | `production` skips serving the frontend, for running behind a web server |

At least one of `WS_SECRET` and `PUBLIC_SECRET` must be set. Without a
`PUBLIC_SECRET` the page tells operators to ask for one; the text comes
from `joinContact` in `src/js/defaultConfig.js`.

`lib/utils/config.js` holds static lists of `banned` addresses, `trusted`
addresses (treated like the private secret) and `reserved` node names.

## Security model

With a public secret anyone can report, so everything a node sends is
treated as untrusted:

- **Verified nodes.** Run your own nodes with a private `WS_SECRET`. While
  any verified node is online, only verified nodes can introduce new block
  heights into the shared history and answer history requests, and the
  page takes the best block from them. An unverified node reporting a
  made-up height shows that height in its own row, in red, without moving
  the best block, charts or "behind" coloring for anyone else.
- **Names.** A name connected from one address cannot be taken from
  another, stays bound to its address for `NAME_HOLD_MINUTES` after it
  disconnects, and a verified node's name is never available to
  unverified logins.
- **Attribution.** Each connection reports only as the node it logged in
  as; ids inside later messages are ignored.
- **Limits.** Connection rate and names per address, total nodes, message
  size and a per-connection message rate (sustained 5/s) are capped.
  Incoming data is reduced to known fields with bounded lengths and
  ranges, and transaction lists are reduced to counts.
- **Privacy.** Node IP addresses stay on the server. Viewers see only a
  country, city and approximate coordinates.
- **Addresses.** The client address is the socket peer. `X-Forwarded-For`
  is used only when the peer is listed in `TRUSTED_PROXIES`, and then the
  right-most address not belonging to a proxy wins.

What a public dashboard cannot prevent: an unverified node can report
false stats about itself (peers, latency, sync state), and someone with
many addresses can register many names. Treat unverified rows as
self-reported.

## Deployment

Behind a TLS-terminating reverse proxy, build the frontend, serve
`dist/` as static files and proxy the websocket paths to the server:

```nginx
location ~ ^/(api|primus|external) {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

and start the server with `NODE_ENV=production TRUSTED_PROXIES=127.0.0.1`.

A Docker image is available too:

```bash
docker build -t parallax-stats .
docker run -p 3000:3000 -e WS_SECRET=... -e PUBLIC_SECRET=... parallax-stats
```

## Tests

```bash
npm test
```

## License

GPL-3.0, as upstream. See [LICENSE](LICENSE).
