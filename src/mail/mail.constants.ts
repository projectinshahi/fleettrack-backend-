/** Static configuration for outgoing mail. */
export const APP_NAME = 'FleetTrack';

/** Subject line for the password-reset email. */
export const RESET_PASSWORD_SUBJECT = `Reset your ${APP_NAME} password`;

/** Handlebars template file name for the password-reset email. */
export const RESET_PASSWORD_TEMPLATE = 'reset-password.hbs';

/** Templates directory name (resolved relative to the compiled service at runtime). */
export const TEMPLATES_DIR = 'templates';
