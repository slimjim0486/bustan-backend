-- READ-ONLY production preflight for 20260802120000_payout_integrity_audit.
-- Every query must return zero rows before the NOT VALID constraints are
-- validated. The first query requires manual reconciliation even though it
-- does not necessarily prove an incorrect transfer.

SELECT id, restaurant_id, period_start, period_end, paid_at, updated_at,
       deposits_collected_aed, fees_kept_aed, amount_due_aed, reference
FROM payout_records
WHERE status = 'PAID' AND paid_at IS NOT NULL AND updated_at > paid_at
ORDER BY paid_at;

SELECT id, restaurant_id, deposit_aed, fee_aed, status
FROM bookings
WHERE deposit_aed < 0 OR fee_aed < 0 OR deposit_aed < fee_aed;

SELECT id, restaurant_id, deposits_collected_aed, fees_kept_aed, amount_due_aed, status
FROM payout_records
WHERE deposits_collected_aed < 0
   OR fees_kept_aed < 0
   OR amount_due_aed < 0
   OR amount_due_aed <> deposits_collected_aed - fees_kept_aed;
