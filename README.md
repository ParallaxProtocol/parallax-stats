Parallax Network Stats
======================

A live dashboard of Parallax nodes. Nodes report their own stats over a
websocket when started with `--prlstats`, and every viewer sees them update
live:

- **Block clock:** the best block and how long since it was found, against
  the 10 minute target, with a warning when no block has come for 2 hours
- **Network figures:** average block time, hashrate, difficulty (also in
  the units pools use), active nodes in sync, the recommended fee, peer
  latency, uptime
- **Charts:** block times, propagation, difficulty with the next block's
  exact difficulty and the drift from the 10 minute schedule, transactions,
  block fullness and fees paid to miners
- **Supply:** the next halving, coins issued against the 21 million cap,
  and the top miners with how concentrated mining is
- **Chain health:** stale blocks and reorganizations, and which client
  releases nodes run against the latest on GitHub
- **Nodes:** a sortable table with each node's sync state, peers, latency,
  block, propagation history and details, and instructions for adding one

Originally forked from [goerli/ethstats-server](https://github.com/goerli/ethstats-server)
(itself based on [cubedro/eth-netstats](https://github.com/cubedro/eth-netstats)),
now rewritten in TypeScript on Next.js. The reporter protocol is unchanged,
so existing `parallaxd` releases report to it as before.

## Running

Requires Node.js 22.18 or newer (the server runs as TypeScript directly)
and pnpm.

```bash
pnpm install
pnpm build
WS_SECRET=my-private-secret PUBLIC_SECRET=open-secret pnpm start
```

The dashboard is served at http://localhost:3000.

For development, `pnpm dev` starts the same server with hot reloading of
the app. Changes to `server.ts` or `src/server/` need a restart. To see
the dashboard move without a network, run simulated nodes against it:

```bash
pnpm dev           # in one terminal
pnpm simulate      # in another: 8 nodes against localhost:3000
```

The simulator uses the secrets from your `.env` files and builds a chain
that follows mainnet's difficulty rules. Add `TRUSTED_PROXIES=127.0.0.1,::1`
to the `.env` file too, so the simulated nodes get map locations and are
not all counted as one address.

## Adding a node

The page's "Add your node" button walks operators through it and checks
whether a name is free. In short, start `parallaxd` with the dashboard's
address and a secret:

```bash
parallaxd --prlstats "my-node:open-secret@stats.example.org"
```

or put the same value in the config file and start with `--config`:

```toml
[ParallaxStats]
URL = "my-node:open-secret@stats.example.org"
```

The node dials `wss://<host>/api` and falls back to `ws://`, so it needs
no open ports. For a node using a private secret, write the scheme so it
never falls back to unencrypted `ws://`, where the secret would cross the
network in clear text:

```bash
parallaxd --prlstats "my-node:my-private-secret@wss://stats.example.org"
```

Fees paid to miners are reported by parallaxd versions that include
`node/stats: report the fees paid to the miner per block`. Older nodes
report everything else, and their blocks show fees as not reported.

## Settings

All settings come from the environment.

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_SECRET` | | Private secrets, separated by `\|`. Nodes using one are **verified**. |
| `PUBLIC_SECRET` | | Secret you publish for everyone else. Nodes using it are unverified. |
| `PORT` | `3000` | Listen port |
| `RPC_URL` | `https://rpc.parallaxprotocol.org` | Parallax RPC endpoint the recommended fee is read from |
| `SITE_URL` | | Public address, such as `https://stats.example.org`, for absolute links in link previews. Without it, the forwarded host is used. |
| `TRUSTED_PROXIES` | | Reverse proxies allowed to set `X-Forwarded-For`: addresses or ranges such as `10.0.0.0/8` |
| `TRUSTED_IPS` | | Addresses whose nodes are treated as verified |
| `BANNED_IPS` | | Addresses or ranges refused outright |
| `RESERVED_NAMES` | | Node names no one may log in with |
| `MAX_NODES` | `1000` | Nodes tracked in total, connected or disconnected in the last 4 hours. Verified nodes are always admitted. |
| `MAX_NODES_PER_IP` | `3` | Names one address may hold, connected or recently disconnected (unverified nodes only) |
| `CONN_PER_MINUTE` | `10` | New reporter connections per address per minute |
| `NAME_HOLD_MINUTES` | `60` | How long a disconnected name stays bound to its address |
| `MAX_MESSAGE_BYTES` | `4194304` | Largest reporter message accepted |
| `MAX_VIEWERS_PER_IP` | `20` | Dashboard connections one address may hold open |

Lists are separated by `|` or `,`. At least one of `WS_SECRET` and
`PUBLIC_SECRET` must be set. The public secret is shown on the page, in
the "Add your node" instructions, along with a command that uses it.

Settings can also go in `.env.local` (or `.env`, `.env.production`, …),
loaded the same way Next.js loads them; variables set in the environment
win over the files.

Keep private secrets long and random (`openssl rand -hex 32`); the server
warns at startup about short ones. They stay on the server: only server
code reads them, they are never logged, sent to viewers or included in the
build, and `.env*` files are kept out of git and the Docker image. Never
give a secret a `NEXT_PUBLIC_` name, which would ship it to browsers.

The server makes two kinds of outbound request: the recommended gas price
from `RPC_URL` once a minute, and the latest parallaxd release from the
GitHub API at most once an hour. If either is unreachable, its figure shows
as unavailable and the rest of the dashboard carries on.

## JSON API

- `GET /api/v1/stats` returns a summary of the network (best block, when
  it arrived, node counts, median peer latency, average block time,
  hashrate and difficulty) for scripts and other sites. It allows
  cross-origin requests.
- `GET /api/v1/names?name=…` tells the caller whether they can report under
  a node name: `available`, `yours` (held for the caller's own address),
  `taken`, `reserved` or `invalid`. It answers only that, never which node
  holds a name, and allows 20 checks per minute per address.

## How the figures are worked out

- **Block times** are the difference between a block's timestamp and its
  parent's. Blocks whose parent is not yet in the history have none.
- **Hashrate** is the total difficulty of the newest unbroken run of up to
  64 blocks over the time they took: a block takes `difficulty` hashes on
  average.
- **Difficulty** is the chain's own value, as in block headers and over RPC.
  Pools show the same figure divided by 2^32, the Bitcoin convention; both
  are on the page. On mainnet, the next block's difficulty and the drift
  from the 10 minute schedule come from a port of the protocol's ASERT
  difficulty adjustment (`src/lib/asert.ts`), checked against real blocks.
- **Supply and halvings** follow the protocol's reward schedule: 50 LAX a
  block, halving every 210,000 blocks, against a 21 million cap. Halving
  dates assume 10 minute blocks, the rate difficulty adjustment holds.
- **Stale blocks and reorgs** count only what a verified node saw (or, with
  none online, two nodes), so a node reporting made-up blocks cannot
  inflate them.
- **Recommended fee** is the RPC endpoint's `eth_gasPrice`. Parallax has
  no base fee, so the gas price is the whole fee; a plain transfer uses
  21,000 gas.
- **Possible stall** shows after 2 hours without a block. Block intervals
  vary with luck: an hour happens, two hours is a one-in-160,000 wait at
  steady hashrate.

## Security model

With a public secret anyone can report, so everything a node sends is
treated as untrusted:

- **Verified nodes.** Run your own nodes with a private `WS_SECRET`. While
  any verified node is online, only verified nodes can introduce new block
  heights into the shared history and answer history requests, and the
  page takes the best block from them. An unverified node reporting a
  made-up height shows that height in its own row without moving the best
  block or the charts for anyone else.
- **Names.** A name connected from one address cannot be taken from
  another, stays bound to its address for `NAME_HOLD_MINUTES` after it
  disconnects, and a verified node's name is never available to
  unverified logins.
- **Attribution.** Each connection reports only as the node it logged in
  as; ids inside later messages are ignored.
- **Limits.** Connection rate and names per address, total nodes, message
  size and a per-connection message rate (sustained 5/s) are capped.
  Incoming data is reduced to known fields with bounded lengths and
  ranges, and transaction lists are reduced to counts. Viewer connections
  and name checks are capped per address, and viewers too slow to keep up
  are dropped rather than buffered.
- **Pseudonyms.** Only verified nodes are listed under the name they chose.
  Everyone else appears under a pseudonym such as `node-3f9a2c1b`, derived
  from the name with a per-process key, so public rows cannot carry
  arbitrary text or impersonate known operators. The real name only
  identifies the node to the server.
- **Privacy.** Node IP addresses stay on the server. Viewers see only a
  country, city and approximate coordinates.
- **Addresses.** The client address is the socket peer. `X-Forwarded-For`
  is used only when the peer is in `TRUSTED_PROXIES`, and then the
  right-most address not belonging to a proxy wins.

What a public dashboard cannot prevent: an unverified node can report
false stats about itself (peers, latency, sync state), and someone with
many addresses can register many names. Treat unverified rows as
self-reported.

## How it is built

- `server.ts` runs one HTTP server for the Next.js app, the name check and
  the two websockets: `/api` for reporting nodes (the Primus-framed JSON
  protocol `parallaxd` speaks) and `/live` for browsers.
- `src/server/` holds the server state: settings, login guards, sanitizers,
  the node registry and the shared block history.
- `src/lib/` holds what both sides share: the protocol, formatting, and the
  emission and ASERT rules.
- `src/app/` is the Next.js app. With Cache Components the page shell and
  world map are prerendered, and the current network state streams in with
  the first response, so the page shows data before any script runs. The
  browser then keeps it current over `/live`.

All state is in memory. After a restart the node list refills as nodes
reconnect, and the block history backfills from them within minutes.

## Deployment

The server keeps its state in memory, so run a single instance.

### Coolify

1. Create an application from this repository with the **Dockerfile**
   build pack, and set the exposed port to `3000`.
2. Give it a domain, such as `https://stats.example.org`. Coolify's Traefik
   terminates TLS and passes websocket upgrades through; nothing else is
   needed for `/api` and `/live`.
3. Set the environment variables (runtime; the build needs none):

   ```
   WS_SECRET=<random, e.g. openssl rand -hex 32>
   PUBLIC_SECRET=<the secret you publish>
   TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
   SITE_URL=https://stats.example.org
   ```

   `TRUSTED_PROXIES` matters: Traefik reaches the app from a Docker network
   address that can change between deploys. Without it, every node and
   viewer would appear to come from Traefik, and the per-address limits
   would admit only three unverified nodes in total.
4. The image has a health check on `/api/v1/stats`, which Coolify picks up.
   Keep the application at one replica.

If the domain is proxied through Cloudflare, either add
[Cloudflare's address ranges](https://www.cloudflare.com/ips/) to
`TRUSTED_PROXIES` or leave the record DNS-only. Otherwise visitors appear as
Cloudflare's addresses.

Nodes then report to `wss://stats.example.org/api`.

### Other reverse proxies

Send everything to the server and allow websocket upgrades, for example
with nginx:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
}
```

and start the server with `TRUSTED_PROXIES=127.0.0.1`.

### Docker

```bash
docker build -t parallax-stats .
docker run -p 3000:3000 -e WS_SECRET=... -e PUBLIC_SECRET=... parallax-stats
```

## Tests

```bash
pnpm test
```

## License

GPL-3.0, as upstream. See [LICENSE](LICENSE).
