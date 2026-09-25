import type { Role } from '../../../shared/access-control';

/**
 * The authenticated caller of a request.
 *
 * `wallet` is set only for `end_user`: it is the Stellar account the caller
 * proved control of, and the only thing ownership checks compare against.
 * `subject` is a stable label for audit logs (a wallet, or a token fingerprint
 * for operators and services), never the credential itself.
 */
export interface Actor {
  role: Role;
  subject: string;
  wallet?: string;
}

export const ANONYMOUS_ACTOR: Actor = Object.freeze({ role: 'anonymous', subject: 'anonymous' });

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware on every request that passes through it. */
      actor?: Actor;
    }
  }
}
