/**
 * Anti-Spam Relay Protection & Circuit Breaker Service (Issue #38, Phase E).
 *
 * Prevents malicious actors from using the unauthenticated invoice creation/proof
 * email flow as an open spam relay by:
 * 1. Enforcing per-wallet outbound email rate limits separate from IP limits.
 * 2. Validating recipient addresses against strict format rules & header-injection attacks.
 * 3. Tracking bounce & complaint rates to trigger an automatic circuit breaker.
 * 4. Preserving paused emails during breaker trip without dropping legitimate customer sends.
 */

import type { CircuitBreakerMetrics, EmailRateLimitConfig } from '../types/email';

const DEFAULT_CONFIG: EmailRateLimitConfig = {
  maxEmailsPerHourPerWallet: 10,
  bounceRateThreshold: 0.05, // 5% bounce rate threshold
  complaintRateThreshold: 0.001, // 0.1% complaint rate threshold
  minSampleSizeForBreaker: 10, // Minimum sent count before tripping
};

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export class EmailAntiSpamService {
  private config: EmailRateLimitConfig;
  private walletSendTimestamps: Map<string, number[]> = new Map();
  private metrics: {
    totalSent: number;
    totalDelivered: number;
    totalBounces: number;
    totalComplaints: number;
    isTripped: boolean;
    trippedReason?: string;
    trippedAt?: Date;
  } = {
    totalSent: 0,
    totalDelivered: 0,
    totalBounces: 0,
    totalComplaints: 0,
    isTripped: false,
  };

  constructor(config: Partial<EmailRateLimitConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Validate email address for RFC compliance and check for carriage return / line feed injection.
   */
  public validateRecipient(email: unknown): { valid: boolean; error?: string; normalized?: string } {
    if (typeof email !== 'string' || !email.trim()) {
      return { valid: false, error: 'Recipient email is required' };
    }

    const trimmed = email.trim();
    if (trimmed.length > 254) {
      return { valid: false, error: 'Email exceeds maximum length of 254 characters' };
    }

    // Guard against CRLF header injection
    if (/[\r\n]/.test(trimmed)) {
      return { valid: false, error: 'Email contains invalid control characters' };
    }

    if (!EMAIL_REGEX.test(trimmed)) {
      return { valid: false, error: 'Invalid email address format' };
    }

    return { valid: true, normalized: trimmed.toLowerCase() };
  }

  /**
   * Check if a wallet is allowed to send an outbound email under the per-wallet rate limit.
   */
  public checkWalletRateLimit(
    walletAddress: string,
    now: number = Date.now()
  ): { allowed: boolean; retryAfterSeconds?: number; currentCount: number; maxAllowed: number } {
    if (!walletAddress) {
      return { allowed: false, retryAfterSeconds: 3600, currentCount: 0, maxAllowed: this.config.maxEmailsPerHourPerWallet };
    }

    const oneHourAgo = now - 3600 * 1000;
    const timestamps = (this.walletSendTimestamps.get(walletAddress) || []).filter((ts) => ts > oneHourAgo);
    this.walletSendTimestamps.set(walletAddress, timestamps);

    if (timestamps.length >= this.config.maxEmailsPerHourPerWallet) {
      const oldestInWindow = timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + 3600 * 1000 - now) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        currentCount: timestamps.length,
        maxAllowed: this.config.maxEmailsPerHourPerWallet,
      };
    }

    return {
      allowed: true,
      currentCount: timestamps.length,
      maxAllowed: this.config.maxEmailsPerHourPerWallet,
    };
  }

  /**
   * Record a send attempt for rate-limiting purposes.
   */
  public recordWalletSend(walletAddress: string, timestamp: number = Date.now()): void {
    const list = this.walletSendTimestamps.get(walletAddress) || [];
    list.push(timestamp);
    this.walletSendTimestamps.set(walletAddress, list);
    this.metrics.totalSent += 1;
  }

  /**
   * Record delivery event.
   */
  public recordDelivery(): void {
    this.metrics.totalDelivered += 1;
    this.evaluateCircuitBreaker();
  }

  /**
   * Record bounce event and evaluate circuit breaker.
   */
  public recordBounce(): void {
    this.metrics.totalBounces += 1;
    this.evaluateCircuitBreaker();
  }

  /**
   * Record complaint event and evaluate circuit breaker.
   */
  public recordComplaint(): void {
    this.metrics.totalComplaints += 1;
    this.evaluateCircuitBreaker();
  }

  /**
   * Evaluates bounce and complaint rates against thresholds and automatically trips the circuit breaker if exceeded.
   */
  private evaluateCircuitBreaker(): void {
    const total = Math.max(this.metrics.totalSent, this.metrics.totalDelivered + this.metrics.totalBounces + this.metrics.totalComplaints);
    if (total < this.config.minSampleSizeForBreaker) {
      return;
    }

    const bounceRate = this.metrics.totalBounces / total;
    const complaintRate = this.metrics.totalComplaints / total;

    if (bounceRate > this.config.bounceRateThreshold) {
      this.tripCircuitBreaker(`Bounce rate of ${(bounceRate * 100).toFixed(2)}% exceeded threshold of ${(this.config.bounceRateThreshold * 100).toFixed(2)}%`);
    } else if (complaintRate > this.config.complaintRateThreshold) {
      this.tripCircuitBreaker(`Complaint rate of ${(complaintRate * 100).toFixed(2)}% exceeded threshold of ${(this.config.complaintRateThreshold * 100).toFixed(2)}%`);
    }
  }

  public tripCircuitBreaker(reason: string): void {
    this.metrics.isTripped = true;
    this.metrics.trippedReason = reason;
    this.metrics.trippedAt = new Date();
  }

  public resetCircuitBreaker(): void {
    this.metrics.isTripped = false;
    this.metrics.trippedReason = undefined;
    this.metrics.trippedAt = undefined;
  }

  public getCircuitBreakerMetrics(): CircuitBreakerMetrics {
    const total = Math.max(this.metrics.totalSent, this.metrics.totalDelivered + this.metrics.totalBounces + this.metrics.totalComplaints);
    const bounceRate = total > 0 ? this.metrics.totalBounces / total : 0;
    const complaintRate = total > 0 ? this.metrics.totalComplaints / total : 0;

    return {
      totalSent: this.metrics.totalSent,
      totalDelivered: this.metrics.totalDelivered,
      totalBounces: this.metrics.totalBounces,
      totalComplaints: this.metrics.totalComplaints,
      bounceRate,
      complaintRate,
      isTripped: this.metrics.isTripped,
      trippedReason: this.metrics.trippedReason,
      trippedAt: this.metrics.trippedAt,
    };
  }

  public isCircuitBreakerTripped(): boolean {
    return this.metrics.isTripped;
  }

  public resetAll(): void {
    this.walletSendTimestamps.clear();
    this.metrics = {
      totalSent: 0,
      totalDelivered: 0,
      totalBounces: 0,
      totalComplaints: 0,
      isTripped: false,
    };
  }
}

export const emailAntiSpamService = new EmailAntiSpamService();
export default emailAntiSpamService;
