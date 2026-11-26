/**
 * Familista billing (P6) — the one door to a payment provider, and today it is closed.
 *
 * No provider is chosen or contracted, so none is built: selectPaymentProvider() answers the unconfigured provider,
 * which refuses to start a checkout and says why. A future adapter implements PaymentProvider; its webhook handler
 * verifies the provider's signature and hands each verified event to applyPaymentEvent (subscription.service.ts), which
 * is the only path that can mark an invoice paid — and the database refuses that too unless the event is recorded first.
 * PAYMENT_PROVIDER names the adapter; with no adapter of that name, the answer is the same unconfigured provider.
 */
export interface CheckoutSession { url: string; providerRef: string }
export interface PaymentProvider {
  readonly name: string;
  isConfigured(): boolean;
  /** Why it is not configured, in one sentence; never a secret's value. */
  configurationProblem(): string | null;
  /** Start the provider's own checkout for an open invoice. Never called unless isConfigured(). */
  createCheckout(invoice: { id: string; number: string; totalMinor: number; currency: string; description: string }): Promise<CheckoutSession>;
}
/** A provider's report about an invoice, after its signature was verified by the adapter. */
export interface VerifiedPaymentEvent { provider: string; providerEventId: string; invoiceId: string; status: 'SUCCEEDED' | 'FAILED'; amountMinor: number; currency: string; occurredAt: Date }

export class PaymentsNotConfiguredError extends Error {
  readonly code = 'PAYMENTS_NOT_CONFIGURED';
  constructor(readonly problem: string) { super('Online payment is not available: no payment provider is configured'); this.name = 'PaymentsNotConfiguredError'; }
}

class UnconfiguredProvider implements PaymentProvider {
  readonly name = 'none';
  constructor(private readonly asked: string | null) {}
  isConfigured(): boolean { return false; }
  configurationProblem(): string {
    return this.asked ? `No payment adapter named "${this.asked.slice(0, 40)}" is built; payments stay off until one is approved and built.` : 'No payment provider is chosen; payments stay off until one is approved and built.';
  }
  async createCheckout(): Promise<CheckoutSession> { throw new PaymentsNotConfiguredError(this.configurationProblem()); }
}

let override: PaymentProvider | null = null;
/** Tests install a provider double here; production never does. */
export function setPaymentProvider(p: PaymentProvider | null): void { override = p; }
export function selectPaymentProvider(env: Record<string, string | undefined> = process.env): PaymentProvider {
  if (override) return override;
  const asked = (env.PAYMENT_PROVIDER ?? '').trim().toLowerCase();
  return new UnconfiguredProvider(asked && asked !== 'none' ? asked : null);
}
export function paymentsConfiguration(): { configured: boolean; provider: string; problem: string | null } {
  const p = selectPaymentProvider();
  return { configured: p.isConfigured(), provider: p.name, problem: p.isConfigured() ? null : p.configurationProblem() };
}
