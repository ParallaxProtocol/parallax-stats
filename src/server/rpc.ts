// The recommended gas price, from a Parallax RPC endpoint. Without a base
// fee (London is not enabled), eth_gasPrice is the whole recommendation.

const TIMEOUT_MS = 5000;
/** Anything above this is a broken response, not a gas price. */
const MAX_GAS_PRICE = 10n ** 24n;

/** fetchGasPrice returns the endpoint's suggested gas price in wei, or null when it cannot be read. */
export async function fetchGasPrice(url: string): Promise<bigint | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) return null;

    const { result } = (await res.json()) as { result?: unknown };

    if (typeof result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(result)) return null;

    const price = BigInt(result);

    return price <= MAX_GAS_PRICE ? price : null;
  } catch {
    return null;
  }
}
