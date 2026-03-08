import { FakeMoltbookVerifier, HttpMoltbookVerifier, type MoltbookVerifier } from './moltbook.js';

/**
 * Creates the appropriate MoltbookVerifier based on environment configuration.
 *
 * - If `MOLTBOOK_API_URL` is set → returns HttpMoltbookVerifier (real API client)
 * - If `MOLTBOOK_API_URL` is unset → returns FakeMoltbookVerifier (dev/test mode)
 *
 * This ensures zero behaviour change in dev/test while enabling real identity
 * verification in production by simply setting environment variables.
 */
export function createMoltbookVerifier(): MoltbookVerifier {
  const apiUrl = process.env.MOLTBOOK_API_URL;
  const apiKey = process.env.MOLTBOOK_API_KEY;

  if (!apiUrl) {
    return new FakeMoltbookVerifier();
  }

  if (!apiKey) {
    throw new Error(
      'MOLTBOOK_API_KEY must be set when MOLTBOOK_API_URL is configured. ' +
      'The API key is required for server-to-server authentication with the Moltbook Identity API.'
    );
  }

  return new HttpMoltbookVerifier({
    apiUrl,
    apiKey
  });
}
