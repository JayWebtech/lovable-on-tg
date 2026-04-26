export interface BuildJobData {
  buildId: string;
  /** Telegram user id as string (safe for large ids) */
  telegramId: string;
  /** Chat where status messages should be edited/sent */
  chatId: string;
  messageId: number;
  prompt: string;
}

export interface PaymentTimerJobData {
  buildId: string;
}
