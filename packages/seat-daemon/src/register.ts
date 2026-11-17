// Telling the host where to push. The host authenticates with the seat token, so a daemon cannot
// register a subscription for a seat it does not hold. Registration is idempotent per (seat, url):
// restarting the daemon reuses the same subscription instead of piling up new ones.

export interface SubscriptionSpec {
  /** Table host base URL, e.g. http://127.0.0.1:7341 */
  url: string;
  table: string;
  seat: string;
  /** The seat's bearer token: the proof that this daemon speaks for that seat. */
  token: string;
  /** What the host POSTs to, e.g. http://127.0.0.1:7342/wake */
  deliverTo: string;
  wakeToken?: string;
}

export async function registerSubscription(spec: SubscriptionSpec): Promise<{ id: string }> {
  const res = await fetch(`${spec.url.replace(/\/+$/, '')}/v0.1/tables/${encodeURIComponent(spec.table)}/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${spec.token}` },
    body: JSON.stringify({ url: spec.deliverTo, token: spec.wakeToken }),
    signal: AbortSignal.timeout(5000),
  });
  const body = (await res.json()) as { id?: string; error?: { message?: string } };
  if (!res.ok || !body.id) throw new Error(`register: HTTP ${res.status} ${body.error?.message ?? ''}`.trim());
  return { id: body.id };
}

export async function unregisterSubscription(spec: SubscriptionSpec, id: string): Promise<boolean> {
  const res = await fetch(`${spec.url.replace(/\/+$/, '')}/v0.1/tables/${encodeURIComponent(spec.table)}/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${spec.token}` },
    signal: AbortSignal.timeout(5000),
  });
  return res.ok;
}

/**
 * Register, retrying while the host is down. The daemon starts before the host on a reboot often
 * enough that a single attempt would leave a table no one is listening to until the next restart.
 */
export async function retryRegister(spec: SubscriptionSpec, attempts = 8): Promise<string> {
  let last: Error | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      const { id } = await registerSubscription(spec);
      return id;
    } catch (err) {
      last = err as Error;
      const wait = Math.min(60_000, 500 * 2 ** i);
      console.warn(`seat-daemon: registration failed (${last.message}); retrying in ${wait} ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last ?? new Error('register failed');
}

/** Build the spec from CLI flags. Null when the daemon was told not to register. */
export function subscriptionSpecFrom(flags: Record<string, string>): SubscriptionSpec | null {
  if (flags['no-register'] === 'true') return null;
  const url = flags.url;
  const table = flags.table;
  const seat = flags.seat;
  const token = flags.token;
  if (!url || !table || !seat || !token) return null;
  const advertiser = flags.advertise ?? flags.listen ?? '127.0.0.1:7342';
  const base = /^https?:\/\//.test(advertiser) ? advertiser : `http://${advertiser}`;
  return { url, table, seat, token, deliverTo: base.replace(/\/+$/, '') + '/wake', wakeToken: flags['wake-token'] };
}
