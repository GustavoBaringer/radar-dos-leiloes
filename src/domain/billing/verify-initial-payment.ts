export type InitialPaymentReason =
  | 'missing_checkout' | 'missing_payment' | 'missing_subscription'
  | 'invalid_plan' | 'payment_id_mismatch' | 'checkout_mismatch'
  | 'subscription_mismatch' | 'value_mismatch' | 'billing_type_mismatch'
  | 'cycle_mismatch' | 'subscription_not_active' | 'payment_not_confirmed';

export type InitialPaymentOutcome =
  | { kind: 'eligible'; paymentId: string; subscriptionId: string; checkoutId: string }
  | { kind: 'pending' | 'review'; reason: InitialPaymentReason };

type Attempt = {
  checkoutId: string | null;
  priceCents: number;
  currency: string;
  billingType: string;
  cycle: string;
};

type CanonicalPayment = {
  id: string;
  status: string;
  value: number;
  billingType: string;
  checkoutSession: string | null;
  subscription: string | null;
};

type CanonicalSubscription = {
  id: string;
  status: string;
  value: number;
  cycle: string;
  checkoutSession: string | null;
};

/** Inputs must be the server's attempt and canonical Asaas GET snapshots, never webhook or redirect data. */
export function verifyInitialPayment(input: {
  attempt: Attempt;
  candidatePaymentId: string;
  payment: CanonicalPayment | null;
  subscription: CanonicalSubscription | null;
}): InitialPaymentOutcome {
  const { attempt, candidatePaymentId, payment, subscription } = input;
  if (!attempt.checkoutId) return { kind: 'pending', reason: 'missing_checkout' };
  if (!payment) return { kind: 'pending', reason: 'missing_payment' };
  if (!subscription) return { kind: 'pending', reason: 'missing_subscription' };
  if (attempt.priceCents !== 6990 || attempt.currency !== 'BRL'
    || attempt.billingType !== 'CREDIT_CARD' || attempt.cycle !== 'MONTHLY') {
    return { kind: 'review', reason: 'invalid_plan' };
  }
  if (!candidatePaymentId || payment.id !== candidatePaymentId) return { kind: 'review', reason: 'payment_id_mismatch' };
  if (payment.checkoutSession !== attempt.checkoutId || subscription.checkoutSession !== attempt.checkoutId) {
    return { kind: 'review', reason: 'checkout_mismatch' };
  }
  if (payment.subscription !== subscription.id) return { kind: 'review', reason: 'subscription_mismatch' };
  if (payment.value !== 69.9 || subscription.value !== 69.9) return { kind: 'review', reason: 'value_mismatch' };
  if (payment.billingType !== 'CREDIT_CARD') return { kind: 'review', reason: 'billing_type_mismatch' };
  if (subscription.cycle !== 'MONTHLY') return { kind: 'review', reason: 'cycle_mismatch' };
  if (subscription.status !== 'ACTIVE') return { kind: 'review', reason: 'subscription_not_active' };
  if (payment.status === 'PENDING') return { kind: 'pending', reason: 'payment_not_confirmed' };
  if (payment.status !== 'CONFIRMED' && payment.status !== 'RECEIVED') {
    return { kind: 'review', reason: 'payment_not_confirmed' };
  }
  return { kind: 'eligible', paymentId: payment.id, subscriptionId: subscription.id, checkoutId: attempt.checkoutId };
}
