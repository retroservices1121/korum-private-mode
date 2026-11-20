export const PLAIN_PORT = 3100;
export const MOCK_PORT = 3101;
/** Normal production build. */
export const PLAIN_URL = `http://localhost:${PLAIN_PORT}`;
/** Production build with the scripted e2e engine (KORUM_E2E_MOCK_PROVIDER=1). */
export const MOCK_URL = `http://localhost:${MOCK_PORT}`;
