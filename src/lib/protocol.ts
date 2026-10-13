// Data shapes shared by the server and the browser, and the messages on
// the viewer websocket. Nodes report over a different, Primus-framed
// protocol that the server translates into these.

export const VIEWER_PATH = "/live";
export const REPORTER_PATH = "/api";
/** GET ?name=… tells an operator whether they can log in with a node name. */
export const NAME_CHECK_PATH = "/api/v1/names";
/** The JSON stats endpoints, served by Next.js once the hub has rate limited them. */
export const STATS_PATHS = ["/api/v1/stats", "/api/v2/stats"];

/**
 * Whether the asker can use a node name: free, already theirs (held for
 * their own address), held from another address, or reserved for a
 * verified node or by the operator.
 */
export type NameStatus = "available" | "yours" | "taken" | "reserved" | "invalid";

/** Blocks shown in the per-node propagation strip and the charts. */
export const HISTORY_BINS = 40;

/** The figures' trend charts: 7 days in 4 hour slices, aligned to UTC, the last one in progress. */
export const TREND_SLICE_S = 4 * 3600;
export const TREND_SLICES = 42;

/**
 * Trends holds a value for each trend slice, oldest first, or null where
 * there was nothing to measure: no blocks, or the dashboard was down.
 */
export interface Trends {
  /** Start of each slice, unix seconds. */
  start: number[];
  /** Mean seconds between the slice's blocks and their parents. */
  blocktime: (number | null)[];
  /** Estimated hashes per second: the slice's work over the time it took. */
  hashrate: (number | null)[];
  /** Mean difficulty of the slice's blocks. */
  difficulty: (number | null)[];
  /** Transactions in the slice's blocks; the last slice is still in progress. */
  transactions: (number | null)[];
  /** Mean share of the gas limit the slice's blocks used, 0..1. */
  fullness: (number | null)[];
  /** Mean fees paid to the miner by the slice's blocks that reported them, wei. */
  fees: (number | null)[];
  /** Means of the readings the server takes every few minutes. */
  active: (number | null)[];
  synced: (number | null)[];
  /** Recommended gas price, wei. */
  gasPrice: (number | null)[];
  /** Median latency of nodes to their peers, ms. */
  peerLatency: (number | null)[];
  /** Mean uptime of verified nodes, 0..100. */
  uptime: (number | null)[];
  /** Transactions waiting in the mempool, the median of synced nodes. */
  pending: (number | null)[];
  /** LAX price in US dollars, from CoinGecko. */
  price: (number | null)[];
  /** US dollars of LAX traded over the 24 hours to each reading, from CoinGecko. */
  volume: (number | null)[];
}

/** trendStarts gives the start of each trend slice at `now` (ms), oldest first. */
export function trendStarts(now: number): number[] {
  const current = Math.floor(now / 1000 / TREND_SLICE_S) * TREND_SLICE_S;

  return Array.from({ length: TREND_SLICES }, (_, i) => current - (TREND_SLICES - 1 - i) * TREND_SLICE_S);
}

/** Target block interval of the network, in seconds. */
export const TARGET_BLOCK_TIME = 600;

export interface Block {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  miner: string;
  gasUsed: number;
  gasLimit: number;
  /** Decimal strings: difficulties overflow JavaScript numbers. */
  difficulty: string;
  totalDifficulty: string;
  transactionsRoot: string;
  stateRoot: string;
  sha3Uncles: string;
  txCount: number;
  uncleCount: number;
  /** Transaction fees paid to the miner, wei as a decimal string; null when unknown (older reporters). */
  fees: string | null;
  /** Server time the first node reported this block, ms. */
  arrived: number;
  /** Server time this node reported it, ms. */
  received: number;
  /** received - arrived, ms; -1 for a catch-up report, from a node syncing or just connected, which times nothing. */
  propagation: number;
  /** Time since the parent block, ms. */
  time: number;
}

export interface NodeInfo {
  name: string;
  node: string;
  port: number;
  net: string;
  protocol: string;
  api: string;
  os: string;
  os_v: string;
  client: string;
  canUpdateHistory: boolean;
}

export interface Geo {
  country: string;
  /** [latitude, longitude], to the nearest whole degree */
  ll: [number, number];
}

export interface BasicStats {
  active: boolean;
  mining: boolean;
  syncing: boolean;
  hashrate: number;
  peers: number;
  gasPrice: number;
  uptime: number;
  /** Round trip to this dashboard, ms. */
  latency: number;
  /** Median minimum ping to the node's peers, ms; 0 when unmeasured. */
  peerLatency: number;
}

export interface NodeStats extends BasicStats {
  pending: number;
  block: Block;
  propagationAvg: number;
}

/** A node as viewers see it. Addresses and unverified names stay on the server. */
export interface PublicNode {
  id: string;
  trusted: boolean;
  info: NodeInfo;
  stats: NodeStats;
  /** Propagation delay of the last HISTORY_BINS heights, ms; -1 for none. */
  history: number[];
  geo: Geo | null;
  /** Server time the node was last known connected, ms; null while it is. */
  offlineSince: number | null;
}

/**
 * Upper bounds of the propagation speed bands, ms: under 5 s, 5–15 s,
 * 15–60 s, and 60 s or more. With 10 minute blocks, 15 s is about a 2.5%
 * chance of a competing block and 60 s about 10%: the thresholds of the
 * propagation alert. The node table grades delays the same way.
 */
export const PROPAGATION_BANDS = [5000, 15_000, 60_000] as const;

/** How long blocks took to reach verified nodes after the first verified report. */
export interface PropagationStats {
  /** Verified reports counted; the first of each block is left out, as its delay is 0 by definition. */
  samples: number;
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  /** Reports per speed band, one more entry than PROPAGATION_BANDS. */
  bands: number[];
  /**
   * How long recent blocks took to reach 90% of synced verified nodes, ms:
   * the median over up to 10 blocks with enough verified reports, and a
   * miner whose blocks spread far slower than everyone else's. Null while
   * too few blocks qualify.
   */
  spread?: { median: number; blocks: number; slowMiner: { miner: string; pool: string | null; median: number; blocks: number } | null } | null;
}

/** Competing blocks and reorganizations, as seen by trustworthy reporters. */
export interface ChainHealth {
  /** Heights examined for competing blocks. */
  window: number;
  /** Blocks that lost to another block at the same height. */
  staleBlocks: number;
  /** The latest heights with a stale block, newest first. */
  recentStale: { height: number; at: number }[];
  /** Every height in the window with a stale block, newest first; missing from servers before the block strip. */
  stale?: { height: number; at: number }[];
  /** The reorganizations within the window's heights, oldest first; missing likewise. */
  reorgEvents?: { height: number; at: number; nodes: number; depth: number }[];
  /** The window's lowest and highest heights; null while it is empty, missing likewise. */
  heights?: { from: number; to: number } | null;
  /** Reorganizations seen since `since`. */
  reorgs: number;
  /** Server time the reorg count starts: 24 hours ago, or when the dashboard started. */
  since: number;
  /** The latest reorganization; `depth` is how many blocks it replaced. */
  lastReorg: { height: number; at: number; nodes: number; depth: number } | null;
  /** The latest reorganization 3 or more blocks deep, which a later routine one does not hide. */
  lastDeepReorg?: { height: number; at: number; nodes: number; depth: number } | null;
  /**
   * Set while verified nodes follow different chains, each at least two
   * blocks past where they part: `height` is the last block they share,
   * null when it lies beyond the history.
   */
  split: { height: number | null; chains: number; nodes: number } | null;
}

export interface MiningPool {
  name: string;
  /** The pool's website, http(s) only; null when not given. */
  url: string | null;
}

export interface MinerCount {
  /** The coinbase address; for a known pool, the one of its addresses with the most blocks. */
  miner: string;
  /** The pool when the address belongs to a known one, whose addresses are counted together. */
  pool: MiningPool | null;
  blocks: number;
}

export interface Charts {
  height: number[];
  /** Each block's timestamp, unix seconds. */
  timestamp: number[];
  /** Each block's coinbase address. */
  miner: string[];
  /** Seconds per block. */
  blocktime: number[];
  /** Mean seconds per block over the last 7 days (see minerBlocks and minerSpan). */
  avgBlocktime: number;
  difficulty: string[];
  /** Change in difficulty over the last 7 days, as a fraction; null when the history is shorter. */
  difficultyWeek: number | null;
  transactions: number[];
  /** Transactions in the same blocks as minerBlocks: the last 7 days of them. */
  weekTransactions: number;
  /** Mean share of the gas limit the same blocks used, 0..1. */
  weekFullness: number;
  /** Mean fees per block of those of the same blocks that reported them, wei; null when none did. */
  weekFees: number | null;
  /** How many of the same blocks reported their fees. */
  weekFeeBlocks: number;
  gasSpending: number[];
  gasLimit: number[];
  /** Fees paid to the miner per block, wei as decimal strings; null where unknown. */
  fees: (string | null)[];
  /** The miners of the last 7 days of blocks, most blocks first, up to ten. */
  miners: MinerCount[];
  /** Distinct miners among the same blocks, each known pool counted once. */
  minerCount: number;
  /** How many blocks the miner figures, and avgBlocktime, cover: the last 7 days of them. */
  minerBlocks: number;
  /** Seconds those blocks span, oldest to newest; under 7 days while the history is shorter. */
  minerSpan: number;
  /**
   * The newest blocks of the largest of those miners, newest first, up to
   * WATCH_BLOCKS: whether it still mines in the open. Missing from servers
   * before the watch.
   */
  topMinerBlocks?: { height: number; timestamp: number }[];
  propagation: PropagationStats;
  health: ChainHealth;
  avgHashrate: number;
  trends: Trends;
}

/** The LAX price, as CoinGecko last reported it, with its market. */
export interface Price {
  usd: number;
  /** The price in bitcoin; null when CoinGecko gave none. */
  btc: number | null;
  /** US dollars traded over the last 24 hours, on every exchange CoinGecko tracks; null when unknown. */
  volume24h: number | null;
  /** How the US dollar price moved over the last 24 hours, in percent; null when unknown. */
  change24h: number | null;
  /** When CoinGecko last updated it, ms. */
  at: number;
  /** The coin's page on CoinGecko, which its free API asks to be credited with a link. */
  url: string;
}

/** One pair LAX trades in on one exchange, as CoinGecko last reported it. */
export interface Market {
  exchange: string;
  /** The pair's page on the exchange; null when CoinGecko gave none. */
  url: string | null;
  /** LAX/USDT. */
  pair: string;
  /** US dollars traded over the last 24 hours. */
  volume24h: number;
  /** The gap between the best bid and the best ask, in percent of the price; null when unknown. */
  spread: number | null;
  /** US dollars of orders it takes to move the price 2% up (buying) and down (selling); null when unknown. */
  depthUp: number | null;
  depthDown: number | null;
  /** When it last traded, ms; null when unknown. */
  lastTrade: number | null;
}

/** The kinds of incident the dashboard records: what its alerts warn of, kept once they pass. */
export type IncidentKind = "majority" | "withholding" | "spread" | "split" | "reorg";

/** Something that went wrong, from when it started to when it ended. */
export interface Incident {
  id: string;
  kind: IncidentKind;
  /** The worst it got. */
  level: "warn" | "critical";
  /** Server time it started, ms. */
  start: number;
  /** False when it was already under way when records begin, so it started before `start`. */
  startKnown: boolean;
  /** Server time it ended, ms; null while it lasts. A moment, such as a reorganization, ends as it starts. */
  end: number | null;
  /** What it was at its worst: rplant.xyz mined 87% of the week's blocks. */
  detail: string;
}

export interface IncidentLog {
  /** When the server began recording incidents, ms. */
  since: number;
  /** How far back incidents were rebuilt from saved blocks when recording began, ms; null when none were. */
  rebuiltFrom: number | null;
  /** The last 90 days of incidents, newest first. */
  list: Incident[];
}

export interface Snapshot {
  serverTime: number;
  nodes: PublicNode[];
  charts: Charts | null;
  /** Recommended gas price from the RPC endpoint, wei as a decimal string; null while unknown. */
  gasPrice: string | null;
  /** Known mining pools by coinbase address (lowercase), from MINING_POOLS. */
  pools: Record<string, MiningPool>;
  /** The block explorer's address, from EXPLORER_URL, without a trailing slash; null when not set. */
  explorer: string | null;
  /** The LAX price; null while unknown, or with COINGECKO_ID set empty. */
  price: Price | null;
  /** Where LAX trades, most volume first; null while unknown, or with COINGECKO_ID set empty. */
  markets: Market[] | null;
  /** What went wrong and when; null from a server that records none. */
  incidents: IncidentLog | null;
}

export type ServerMessage =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "node"; node: PublicNode }
  | { type: "block"; id: string; block: Block; propagationAvg: number; history: number[] }
  | { type: "stats"; id: string; stats: BasicStats }
  | { type: "pending"; id: string; pending: number }
  | { type: "latency"; id: string; latency: number }
  | { type: "charts"; charts: Charts }
  | { type: "fee"; gasPrice: string | null }
  | { type: "price"; price: Price | null }
  | { type: "markets"; markets: Market[] }
  | { type: "incidents"; incidents: IncidentLog }
  | { type: "pong"; t: number; serverTime: number };

export type ClientMessage = { type: "ping"; t: number };
