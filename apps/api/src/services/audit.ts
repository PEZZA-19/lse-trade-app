import type { Tx } from '../db/client';
import type { Auth } from '../lib/types';

export async function audit(
  tx: Tx,
  auth: Auth,
  action: string,
  entity: string,
  entityId: string | null,
  data: Record<string, unknown> = {},
) {
  await tx`INSERT INTO audit_log (tenant_id, user_id, action, entity, entity_id, data)
           VALUES (${auth.tenantId}, ${auth.userId}, ${action}, ${entity}, ${entityId}, ${tx.json(data as never)})`;
}
