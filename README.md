Parallax Network Stats
======================

A live dashboard of Parallax nodes. Nodes report their own stats over a
websocket when started with `--prlstats`, and every viewer sees them update
live:

- **Block clock:** the best block and how long since it was found, against
  the 10 minute target
- **Alerts:** verified nodes on different chains, no block for 2 hours,
  reorganizations 3 or more blocks deep, one miner holding most of
  the last week's blocks, blocks slow to reach the network, no verified node
  online, and a new client release that nodes have not caught up with
- **New blocks:** a toast with who mined each block, how long it took, its
  transactions and fees, and an optional chime (with its own sound for
  deep reorganizations)
- **Mining:** hashrate, difficulty (the next block's, also in the units
  pools use) and block time over the last 7 days, block time for each of
  the last 40 blocks, and decentralization
- **Blocks and fees:** transactions, block fullness and fees paid to miners
  per block, and the recommended fee over the last 7 days
- **Nodes:** where they run, active nodes in sync, latency and uptime over
  the last 7 days, propagation, client versions and stale blocks
- **Supply:** the next halving and coins issued against the 21 million cap
- **Decentralization:** who found recent blocks, graded by how few miners
  hold a majority, with each one's share and known pools by name
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
WS_SECRET=my-private-secret PUBLIC_SECRET=true pnpm start
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
not all counted as one address. By default one simulated miner finds 60% of
blocks, so the mining majority alert shows; `SIM_MAJORITY=0` spreads blocks
out, and `SIM_BLOCK_MS` sets the block interval (default 20 s).

## Adding a node

The page's "Add your node" button walks operators through it and checks
whether a name is free. In short, start `parallaxd` with a name for the
node and the dashboard's address:

```bash
parallaxd --prlstats "my-node@stats.example.org"
```

or put the same value in the config file and start with `--config`:

```toml
[ParallaxStats]
URL = "my-node@stats.example.org"
```

Nodes without a secret are unverified and listed under a pseudonym, so
the name only identifies the node to the dashboard across reconnects.

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
| `WS_SECRET` | | Private secrets, separated by `\|`. Nodes using one are **verified**, under the names it allows: see below. |
| `PUBLIC_SECRET` | | Set to anything to let anyone report without a secret, as an unverified node. Nodes reporting with its value are accepted too, for those set up when public nodes needed a secret. |
| `PORT` | `3000` | Listen port |
| `RPC_URL` | `https://rpc.parallaxprotocol.org` | Parallax RPC endpoint the recommended fee is read from |
| `SITE_URL` | | Public address, such as `https://stats.example.org`, for absolute links in link previews. Without it, the forwarded host is used. |
| `TRUSTED_PROXIES` | | Reverse proxies allowed to set `X-Forwarded-For`: addresses or ranges such as `10.0.0.0/8` |
| `BEHIND_CLOUDFLARE` | | Set to `true` when the domain is proxied through Cloudflare, to take visitors' addresses from `CF-Connecting-IP` |
| `TRUSTED_IPS` | | Addresses whose nodes are treated as verified |
| `BANNED_IPS` | | Addresses or ranges refused outright |
| `RESERVED_NAMES` | | Node names no one may log in with |
| `MAX_NODES` | `1000` | Nodes tracked in total, connected or disconnected in the last 4 hours. Verified nodes are always admitted. |
| `MAX_NODES_PER_IP` | `3` | Names one address may hold, connected or recently disconnected (unverified nodes only) |
| `CONN_PER_MINUTE` | `10` | New reporter connections per address per minute |
| `NAME_HOLD_MINUTES` | `60` | How long a disconnected name stays bound to its address |
| `MAX_MESSAGE_BYTES` | `4194304` | Largest reporter message accepted |
| `MAX_VIEWERS_PER_IP` | `20` | Dashboard connections one address may hold open |
| `API_PER_MINUTE` | `60` | Requests to the JSON stats endpoints per address per minute |
| `SECRETS_FILE` | `DATA_DIR/secrets` | A file of further private secrets, one per line, applied while the server runs: see below |
| `DATA_DIR` | | Directory to save state in, so restarts keep the node list, uptimes and block history. Without it, state lives in memory only. |
| `MINING_POOLS` | | Known pools, shown by name under Decentralization: see below |
| `COINGECKO_ID` | `parallax-2` | The coin on CoinGecko whose price, in US dollars, puts the hashprice in dollars. Read every 5 minutes from its free API, which needs no key. Set it empty to show no price. |
| `EXPLORER_URL` | | Block explorer (Blockscout) to link blocks, miners and pending transactions to, such as `https://explorer.parallaxprotocol.org`. Without it, nothing links out. |

Lists are separated by `|` or `,`. At least one of `WS_SECRET` and
`PUBLIC_SECRET` must be set. With `PUBLIC_SECRET` set, the page's "Add
your node" instructions show a command for public nodes. A node giving a
secret that matches neither a private secret nor `PUBLIC_SECRET` is
refused rather than listed unverified, so a mistyped private secret
fails loudly.

Give each verified operator (your own nodes, a pool, an exchange) a secret
of their own, so one can be revoked without touching the others, and limit
it to the names they report under by writing `pattern=secret`, where `*`
matches anything:

```
WS_SECRET=<yours>|rplant-*=<rplant's secret>|exchange-x=<exchange's secret>
```

A limited secret verifies only matching names: a node reporting another
name with it is refused, and the server logs why, so a pool cannot appear
as an exchange or take over another operator's name. A secret without a
pattern verifies any name; keep those to your own nodes. Listing the same
secret twice with different patterns allows both. An entry counts as
`pattern=secret` only when the part before the first `=` is made of name
characters and `*`, and the secret after it is at least 8 characters, so a
secret that just contains `=` is read whole.

### Changing secrets without a restart

Private secrets can also live in a file, `secrets` in `DATA_DIR` unless
`SECRETS_FILE` says otherwise, one entry per line in the same form, with
`#` comments. The server checks it every second: a line added takes effect
at once, and a line removed disconnects the nodes using that secret
straight away. Its entries add to `WS_SECRET`'s.

```
# /data/secrets
rplant-*=3f9a…
exchange-x=7c21…
```

On Coolify, open the application's **Terminal** and edit the file there,
for example:

```bash
# Make a secret for the pool's nodes, add it, and print it to hand over
S=$(node -e "console.log(crypto.randomBytes(32).toString('hex'))")
echo "rplant-*=$S" >> /data/secrets && chmod 600 /data/secrets && echo "$S"
```

To revoke it, delete its line, for example with `sed -i '/^rplant-\*=/d' /data/secrets`.

The server logs how many entries it loaded, never the secrets, and warns
when the file is readable by other users. If the file cannot be read, the
secrets loaded before stay in force rather than everyone being cut off.

`MINING_POOLS` names the pools behind coinbase addresses in the
Decentralization tile, optionally with a website their name links to. Pools are separated by `|`; each is
its name, `=`, then its addresses and website separated by `,`:

```
MINING_POOLS=Example Pool=https://pool.example,0x1111…,0x2222…|Solo Farm=0x3333…
```

A pool's addresses count as one miner throughout, including the
decentralization grade.

Settings can also go in `.env.local` (or `.env`, `.env.production`, …),
loaded the same way Next.js loads them; variables set in the environment
win over the files.

Keep private secrets long and random (`openssl rand -hex 32`); the server
warns at startup about short ones. They stay on the server: only server
code reads them, they are never logged, sent to viewers or included in the
build, and `.env*` files are kept out of git and the Docker image. Never
give a secret a `NEXT_PUBLIC_` name, which would ship it to browsers.

The server makes three kinds of outbound request: the recommended gas
price from `RPC_URL` once a minute, the latest parallaxd release from the
GitHub API at most every 10 minutes, and node locations from
[ip-api.com](https://ip-api.com), the same source as the network atlas on
parallaxprotocol.org. If any is unreachable, its figure shows as
unavailable and the rest of the dashboard carries on.

## JSON API

All endpoints allow cross-origin requests. The stats endpoints allow
`API_PER_MINUTE` requests per minute per address (60 by default, shared
between them) and answer `429` with `Retry-After: 60` beyond that; poll
once every few seconds at most, as the figures change with each block.

### `GET /api/v2/stats`

Everything the dashboard shows. Times are Unix milliseconds unless a field
says seconds; difficulties are decimal strings, as they overflow JSON
numbers; shares are fractions from 0 to 1.

| Field | What it holds |
|---|---|
| `network` | `"mainnet"`, `"other"`, or `null` with no nodes reporting |
| `bestBlock` | `number`, `hash`, `miner`, `pool` (name, when known), `timestamp`, `arrived` |
| `nodes` | `total`, `active`, `synced`, and `latencyMs`: the median of the reporting nodes' latency to their peers |
| `blockTime` | `targetSeconds`; `week`: the 7 day average (`averageSeconds`, `blocks`, `spanSeconds`, and `fullWeek`, false while the server holds less than a week); `recent`: the last 40 blocks' average |
| `hashrate` | `hashesPerSecond`, estimated from difficulty and block times |
| `difficulty` | `latest` (the best block's), `next` (the block being mined, exact on mainnet), `nextPoolUnits` (÷2^32, as pools show it), `changeWeek` |
| `recommendedFee` | `wei`, `gwei`, and `transferLax`: the fee of a plain 21,000 gas transfer |
| `uptime` | `verifiedAveragePercent`: verified nodes' average uptime |
| `decentralization` | over the last 7 days of blocks: `grade` (`healthy`, `fair`, `concentrated`, `critical`), `majorityHolders` (the fewest miners holding a majority, `null` when more than are listed), `distinctMiners`, `topMiners` (`name` and `website` for known pools, `address`, `blocks`, `share`) |
| `staleBlocks` | `window`, `count`, `recent` stale heights, `reorgs` (count and `since`), `lastReorg` and `lastDeepReorg` (`height`, `at`, `nodes`, `depth`), `split`, and the panel's warning `level` |
| `propagation` | `reports`, `medianMs`, `p90Ms`, `p99Ms`, and `reach90`: how long recent blocks took to reach 90% of verified nodes, with any consistently slow miner |
| `alerts` | the alerts showing on the page, most severe first: `type` (`split`, `stall`, `reorg`, `majority`, `propagation`, `slow-miner`, `no-verified-node`, `release`), `level` (`critical`, `warn`, `info`), `since` where it applies, and `details` |

The figures cover the nodes reporting to this dashboard, not the whole
network: see the page's About dialog.

### `GET /api/v1/stats`

The original summary, kept unchanged for existing scripts: best block, when
it arrived, node counts, median latency to peers, average block time,
hashrate and difficulty.

### `GET /api/v1/names?name=…`

Tells the caller whether they can report under a node name: `available`,
`yours` (held for the caller's own address), `taken`, `reserved` or
`invalid`. It answers only that, never which node holds a name, and allows
20 checks per minute per address.

## How the figures are worked out

- **Block times** are the difference between a block's timestamp and its
  parent's. Blocks whose parent is not yet in the history have none. The
  average block time among the top figures covers the last 7 days; the
  Block time chart shows the last 40 blocks and their own average.
- **Hashrate** is the total difficulty of the newest unbroken run of blocks
  over the last 24 hours, over the time they took: a block takes
  `difficulty` hashes on average. Blocks come by luck, so a shorter span
  swings with it: over one 4 hour slice, a steady hashrate can read 20% off.
- **The figures' 7 day charts** split the week into 4 hour slices, aligned
  to UTC. Block time, hashrate and difficulty come from the blocks found:
  the block time and the hashrate pool the blocks of the 24 hours to each
  slice's end, the mean time to their parents and the estimate above, so
  luck in a single slice does not swing them; difficulty is the mean of the
  slice's own blocks. The other figures come from readings the
  server takes every 5 minutes, averaged over each slice; they are kept
  with the rest of the state in `DATA_DIR`, and a slice with no readings,
  while the dashboard was down, is left empty.
- **Difficulty** is the chain's own value, as in block headers and over RPC.
  Pools show the same figure divided by 2^32, the Bitcoin convention; both
  are on the page. On mainnet, the next block's difficulty comes from a
  port of the protocol's ASERT difficulty adjustment (`src/lib/asert.ts`), checked against real blocks.
- **Supply and halvings** follow the protocol's reward schedule: 50 LAX a
  block, halving every 210,000 blocks, against a 21 million cap. Halving
  dates assume 10 minute blocks, the rate difficulty adjustment holds.
- **Stale blocks and reorgs** count only what a verified node saw (or, with
  none online, two nodes), so a node reporting made-up blocks cannot
  inflate them.
- **Decentralization** is graded by the fewest miners that together found
  most of the last 7 days of blocks, which is how many would have to collude to
  rewrite the chain: 4 or more is healthy, 3 fair, 2 concentrated and 1
  critical.
- **Confirmations to wait** is the fewest blocks after which the largest
  miner of the last 7 days, at its share of their blocks, has less than a
  1%, 0.1% or 0.01% chance of replacing a payment by mining in secret: the
  calculation in section 11 of the Bitcoin paper. A pool counts as one
  miner. With a majority, no number is safe.
- **Mempool pressure** is the room the transactions waiting in the
  mempool need, as a share of a block: the median of synced nodes' pending
  transactions (syncing nodes lag the network's, so they are left out),
  each taken to need what recent blocks' transactions did on average, over
  the newest block's gas limit. Under half a block is green, up to two
  blocks amber, and a backlog beyond that red.
- **Hashprice** is what a unit of hashrate earns in a day: a block pays its
  reward and, on average, the fees of recent blocks, and takes `difficulty`
  hashes, so a hash earns that over the difficulty. Block timing does not
  enter into it, so luck does not move it. It is in US dollars at the
  CoinGecko price while one is known, and in LAX otherwise; its 7 day chart
  takes each slice's mean difficulty and mean price, and the week at
  today's block reward.
- **Security budget** is what miners earn in a day, the rough cost of
  renting enough hashrate to rival them: blocks a day at the pace of the
  last 24 hours, times the reward and recent fees, in US dollars at the
  CoinGecko price while one is known. It is compared with the 144 blocks a
  day the schedule pays.
- **Uptime** is the average of verified nodes' uptimes, the share of time
  each has been connected since the server first saw it. Unverified nodes
  come and go as people try things, so they would only add noise.
- **Recommended fee** is the RPC endpoint's `eth_gasPrice`. Parallax has
  no base fee, so the gas price is the whole fee; a plain transfer uses
  21,000 gas.
- **Propagation** is how long after the first report each node reported a
  block, less the node's own one-way latency to the dashboard. Only nodes
  that are synced and have been connected for 2 minutes count, so a node
  catching up after a restart or reconnect does not look like a slow
  network. The alert uses how long recent blocks took to reach 90% of the
  verified nodes: amber over 15 s, red over 60 s, or amber naming a miner
  whose blocks are consistently that slow while everyone else's spread in
  seconds.
- **Reorg depth** is how many blocks a node had that its switch replaced,
  down to the last block both chains share. The server asks the switching
  node for its new chain's recent blocks to find that point. Only
  reorganizations 3 or more blocks deep raise an alert and tint the stale
  blocks panel: amber for 3 to 5 blocks, for 30 minutes, and red from 6
  blocks, for 24 hours. Shallower ones are routine on proof of work and are
  only counted there.
- **Chain splits** are verified nodes on different chains, each at least two
  blocks past where they part. Chains that part only at the newest block
  are an ordinary block race.
- **Incidents** are the alerts' conditions, recorded by the server with
  when each started and ended, and saved with the rest of the state for 90
  days: a mining majority, slow propagation, a chain split, a possible
  stall and no verified node online, each from when it first applied, once
  it has held for 10 minutes (a stall at once), until it has been gone for
  as long; and deep reorganizations, as moments. The page shows the last 30
  days. When recording begins, past stalls and majorities are rebuilt from
  the saved blocks; a majority already holding then is shown as starting
  before that.
- **Possible stall** shows after 2 hours without a block. Block intervals
  vary with luck: an hour happens, two hours is a one-in-160,000 wait at
  steady hashrate.

## Security model

With public nodes open anyone can report, so everything a node sends is
treated as untrusted:

- **Verified nodes.** Run your own nodes with a private `WS_SECRET`. While
  any verified node is online, only verified nodes can introduce new block
  heights into the shared history and answer history requests, and the
  page takes the best block from them. An unverified node reporting a
  made-up height shows that height in its own row without moving the best
  block or the charts for anyone else.
- **Verified operators.** A secret given to someone else can be limited to
  the names they report under (`pattern=secret` in `WS_SECRET`), so it
  cannot verify another operator's nodes or take over their names.
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
- **Privacy.** Node IP addresses are never sent to viewers, who see only a
  country, city and approximate coordinates. To place nodes, the server
  sends their addresses to ip-api.com's free batch endpoint, which is plain
  HTTP; viewers' addresses are never looked up. Answers are cached for a
  day, so reconnects cost no lookups.
- **Addresses.** The client address is the socket peer. `X-Forwarded-For`
  is used only when the peer is in `TRUSTED_PROXIES`, and then the
  right-most address not belonging to a proxy wins. With
  `BEHIND_CLOUDFLARE`, `CF-Connecting-IP` is used only when that address
  is one of [Cloudflare's](https://www.cloudflare.com/ips/), so a client
  connecting to the server directly cannot set its address with it.
- **Saved state.** The file in `DATA_DIR` holds node addresses and the
  names behind pseudonyms, so it is created readable by the server's
  user only. It never holds secrets.

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

The server works from memory. With `DATA_DIR` set, it also saves its
state to a SQLite file there every 30 seconds and on shutdown, and loads
it at startup: nodes come back as offline until they report again, with
their uptimes (neither the time the dashboard was down nor the first 2
minutes of reconnecting is held against them), pseudonyms and propagation history, along with the block history
and reorg counts. Without it, the node list refills as nodes reconnect
and the recent block history backfills from them within minutes.

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
   PUBLIC_SECRET=true
   TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
   SITE_URL=https://stats.example.org
   DATA_DIR=/data
   ```

   For state to survive redeploys, add a volume under **Persistent
   Storage**: name it (e.g. `parallax-stats-data`), leave the source path
   empty and set the destination path to `/data`. Then set `DATA_DIR=/data`.

   `TRUSTED_PROXIES` matters: Traefik reaches the app from a Docker network
   address that can change between deploys. Without it, every node and
   viewer would appear to come from Traefik, and the per-address limits
   would admit only three unverified nodes in total.
4. The image has a health check on `/api/v1/stats`, which Coolify picks up.
   Keep the application at one replica.

If the domain is proxied through Cloudflare (the orange cloud), also set
`BEHIND_CLOUDFLARE=true`. Otherwise every node and viewer appears as the
Cloudflare edge it came through: the map places nodes at the edge's
location, and the per-address limits apply to whole edges. Alternatively,
make the record DNS-only.

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
docker run -p 3000:3000 -e WS_SECRET=... -e PUBLIC_SECRET=true parallax-stats
```

## Tests

```bash
pnpm test
```

## License

GPL-3.0, as upstream. See [LICENSE](LICENSE).
