/**
 * Creates a new ONLINE claim code for one robot (D52) and shows it ONCE.
 *   npm run cloud:claim-code -- --robot <firmware robot id>
 * Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the gateway
 * environment (apps/gateway/.env.local, never the app). Needs internet. The
 * code is generated here; only its SHA-256 is sent. It replaces the robot's
 * previous claim code; online devices that already claimed keep access.
 * This is not the local pairing code: field pairing never uses the cloud.
 */
import { provisionCloudClaimCode } from '../sync/claimCode';
import { parseCloudTarget } from '../sync/postgrest';
import { fail, parseCli } from './args';

const args = parseCli({ robot: { type: 'string' } });
if (!args.robot) fail('--robot <firmware robot id> is required');

async function main(robot: string): Promise<void> {
  // 'field': a claim code is only ever provisioned on the hosted project for a real robot record.
  const target = parseCloudTarget({ url: process.env.SUPABASE_URL, serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY }, 'field');
  const result = await provisionCloudClaimCode({ target, sourceRobotId: robot });
  if (!result.ok) fail(result.message);
  process.stdout.write(
    [
      `New ONLINE claim code for robot ${robot}:`,
      '',
      `    ${result.code}`,
      '',
      'Enter it in the online RoboLime app after it signs in. It is shown only once and is not stored.',
      'It is separate from the local pairing code used on the field laptop.',
      '',
    ].join('\n'),
  );
}

main(args.robot).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
