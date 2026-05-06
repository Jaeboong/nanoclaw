import {
  getRegisteredGroup,
  initDatabase,
  setRegisteredGroup,
} from '../src/db.js';
import { logger } from '../src/logger.js';
import type { RegisteredGroup } from '../src/types.js';

const jid = process.argv[2] ?? process.env.MONITORING_JID ?? process.env.WEBHOOK_GRAFANA_JID;

if (!jid) {
  console.error(
    'usage: tsx scripts/register-monitoring-group.ts <jid>\n' +
      '  or set MONITORING_JID / WEBHOOK_GRAFANA_JID',
  );
  process.exit(1);
}

const group: RegisteredGroup = {
  name: process.env.MONITORING_GROUP_NAME ?? 'Monitoring Channel',
  folder: process.env.MONITORING_GROUP_FOLDER ?? 'monitoring',
  trigger: process.env.MONITORING_GROUP_TRIGGER ?? '@bot',
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
};

initDatabase();
setRegisteredGroup(jid, group);

const stored = getRegisteredGroup(jid);
if (!stored) {
  throw new Error(`Monitoring group registration missing for ${jid}`);
}

logger.info(
  {
    jid,
    folder: stored.folder,
    isMain: stored.isMain === true,
    requiresTrigger: stored.requiresTrigger === true,
  },
  'Monitoring group registered',
);
