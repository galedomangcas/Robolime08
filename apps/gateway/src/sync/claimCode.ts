import { createHash } from 'node:crypto';

import { generatePairingCode, normalizePairingCode } from '../pairing/codes';
import type { CloudTarget } from './postgrest';

/**
 * Online claim codes (D52). A cloud claim code is a NEW random code, separate
 * from the local pairing code. Only its SHA-256 leaves the gateway: the
 * provisioning RPC stores the hash, and `claim_robot()` hashes what the online
 * user types with the same normalisation. 60 bits of entropy plus the
 * server-side attempt limits make guessing impractical.
 */
export function claimCodeSha256(code: string): string {
  return createHash('sha256').update(normalizePairingCode(code), 'utf8').digest('hex');
}

export type ProvisionResult = { ok: true; code: string; robotId: string } | { ok: false; message: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** Calls provision_robot_claim_code() with the service-role key. Never returns or logs the key. */
export async function provisionCloudClaimCode(options: {
  target: CloudTarget;
  sourceRobotId: string;
  fetch?: FetchLike;
  generate?: () => string;
}): Promise<ProvisionResult> {
  const code = (options.generate ?? generatePairingCode)();
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
  let status: number;
  let text: string;
  try {
    const response = await doFetch(`${options.target.origin}/rest/v1/rpc/provision_robot_claim_code`, {
      method: 'POST',
      headers: { ...options.target.credential.headers(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ p_source_robot_id: options.sourceRobotId, p_code_sha256: claimCodeSha256(code) }),
    });
    status = response.status;
    text = await response.text();
  } catch {
    return { ok: false, message: 'Cannot reach the cloud project (no internet?). Nothing was changed.' };
  }
  if (status === 200) {
    let robotId: unknown;
    try {
      robotId = JSON.parse(text);
    } catch {
      robotId = null;
    }
    if (typeof robotId === 'string') return { ok: true, code, robotId };
    return { ok: false, message: 'The cloud project sent an unexpected answer.' };
  }
  if (status === 401 || status === 403) return { ok: false, message: `The cloud project refused the gateway key (HTTP ${status}).` };
  if (status === 404 && text.includes('PGRST202')) {
    return { ok: false, message: 'The cloud project has no claim-flow schema yet (migration 20261028000000 not applied).' };
  }
  if (text.includes('P0002')) {
    return { ok: false, message: `Robot ${options.sourceRobotId} has not been synchronised to the cloud yet. Run the sync worker first.` };
  }
  return { ok: false, message: `The cloud project refused the request (HTTP ${status}).` };
}
