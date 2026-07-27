/**
 * Boot-time registration for the status-line module (barrel-only).
 *
 * Kept separate from index.ts because the router imports index.ts directly
 * for start/stopStatusLine; doing the onDeliveryAdapterReady call here means
 * index.ts has no top-level runtime dependency on delivery.js (so it stays
 * import-safe under the partial delivery.js mocks used in router/permissions
 * tests). Imported for its side effect by src/modules/index.ts.
 */
import { onDeliveryAdapterReady } from '../../delivery.js';

import { setStatusLineAdapter } from './index.js';

onDeliveryAdapterReady(setStatusLineAdapter);
