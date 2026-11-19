import { withTenant, type Sql } from './db/client';
import type { MessageSender } from './lib/messages';
import { releaseDue } from './services/proposals';

/**
 * Releases every held email whose two minutes are up, business by business (Workers cron, every
 * minute). The inbox also releases on view, so this only matters when nobody has the app open.
 * Without a connected sender each one ends "not sent", exactly as on view. One business failing
 * does not stop the others.
 */
export async function releaseHeldEmails(
  sql: Sql,
  sender: MessageSender | null,
): Promise<{ released: number; failed: string[] }> {
  const tenants = await sql<{ tenantId: string }[]>`SELECT tenant_id FROM held_due_tenants()`;
  let released = 0;
  const failed: string[] = [];
  for (const { tenantId } of tenants) {
    try {
      // Authorize the business-wide release as its owner, without making missing identities
      // fail open. releaseDue still records system events (by_user = NULL), not owner actions.
      released += await withTenant(sql, { tenantId, userId: '' }, async (tx) => {
        const [owner] = await tx<{ userId: string }[]>`
          SELECT user_id FROM memberships WHERE tenant_id = ${tenantId} AND role = 'owner' LIMIT 1`;
        if (!owner) throw new Error('Business has no owner');
        await tx`SELECT set_config('app.user_id', ${owner.userId}, true)`;
        return releaseDue(tx, sender);
      });
    } catch {
      failed.push(tenantId);
    }
  }
  return { released, failed };
}
