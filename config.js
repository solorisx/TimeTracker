/* ===========================================================================
 * Time Tracker — local configuration.
 *
 * To enable Google Drive sync, paste your Google OAuth 2.0 Client ID below.
 * The Client ID is NOT a secret — it is meant to be shipped in client-side
 * code. See the "Google Drive setup" section in README.md for the one-time
 * Google Cloud setup (creating the client, authorizing your site's origin).
 *
 * Leave it empty to keep Drive disabled (the app still works with a local
 * data file or browser storage).
 * ======================================================================== */
window.TT_CONFIG = {
  googleClientId: "", // e.g. "1234567890-abc123.apps.googleusercontent.com"
};
