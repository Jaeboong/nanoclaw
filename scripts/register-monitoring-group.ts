import {
  getRegisteredGroup,
  initDatabase,
  setRegisteredGroup,
} from '../src/db.js';
import { logger } from '../src/logger.js';
import type { RegisteredGroup } from '../src/types.js';

const jid = 'dc:1500673538129002606';

const group: RegisteredGroup = {
  name: '두잇뚜 #로그',
  folder: 'discord_main_log',
  trigger: '@Andy',
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
