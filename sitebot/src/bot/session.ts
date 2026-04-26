import type { DomainContact } from "../services/locus.js";

/** In-progress domain registrant collection before Checkout */
export type DomainPurchaseWizard = {
  buildId: string;
  domain: string;
  answers: Partial<Record<keyof DomainContact, string>>;
  stepIndex: number;
};

export interface SessionData {
  /** When set, the next text message is treated as a desired domain name for this build */
  awaitingDomainForBuildId?: string;
  /** After picking a domain, user answers registrant questions one-by-one */
  domainPurchaseWizard?: DomainPurchaseWizard;
}
