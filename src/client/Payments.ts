import type { PaymentsProvider } from "@openfront/shared/ApiSchemas";
import { translateText } from "./Utils";

export type { PaymentsProvider };

/**
 * Inert payment facade.
 *
 * Phase 1 removed the web checkout (Stripe) and the subscription/store
 * surfaces. The cosmetics module still owns soft/hard-currency purchases and
 * the `#purchase-completed` return copy until the cosmetic cleanup group
 * lands, so it keeps importing these four symbols. None of them reaches a
 * payment rail any more: `startPurchase` always reports an error and the
 * helpers classify values that can no longer be produced.
 *
 * The desktop shell's Steam microtransaction bridge was removed with the
 * shell, so the only provider name left is the web one.
 */
export function paymentsProvider(): PaymentsProvider {
  return "stripe";
}

/** What to buy. Kept for the callers that still compile against it. */
export type PurchaseRequest =
  | { kind: "currency_pack"; packName: string }
  | { kind: "custom_currency"; hardAmount: number }
  | { kind: "subscription_tier"; tierName: string };

export type PurchaseOutcome =
  | { outcome: "redirecting" }
  | { outcome: "completed" }
  | { outcome: "cancelled" }
  | { outcome: "pending" }
  | {
      outcome: "error";
      message: string;
      refetchCatalog: boolean;
      manageBilling?: true;
    };

/**
 * Purchases are gone from this build. Callers get the same player-facing
 * failure the old rail produced for an unavailable checkout, so no surface
 * has to special-case the removal.
 */
export async function startPurchase(
  _request: PurchaseRequest,
): Promise<PurchaseOutcome> {
  return {
    outcome: "error",
    message: translateText("store.purchase_failed"),
    refetchCatalog: false,
  };
}

/**
 * Maps an outcome to player-facing copy. Only the branches reachable from the
 * inert `startPurchase` matter; the rest are kept because callers still switch
 * on the full union.
 */
export function purchaseOutcomeMessage(
  outcome: PurchaseOutcome,
  successMessageKey: string,
): string | null {
  if (outcome.outcome === "error") return outcome.message;
  if (outcome.outcome === "completed") return translateText(successMessageKey);
  return null;
}

export type PurchaseReturnStatus = "success" | "pending" | "failed";

/**
 * Reads the `status` param on the `#purchase-completed` landing URL. Unknown
 * or missing values degrade to pending, never to failure.
 */
export function classifyPurchaseReturn(
  status: string | null,
): PurchaseReturnStatus {
  if (status === "true") return "success";
  if (status === "false") return "failed";
  return "pending";
}
