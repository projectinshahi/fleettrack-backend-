/** A fully-rendered email ready to hand to the transport. */
export interface MailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/** Inputs for the password-reset email. */
export interface SendPasswordResetParams {
  to: string;
  resetUrl: string;
  expiresInMinutes: number;
}
