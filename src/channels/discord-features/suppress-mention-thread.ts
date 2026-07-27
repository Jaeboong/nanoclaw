/**
 * Suppress @chat-adapter/discord@4.29.0's auto-thread-on-mention.
 *
 * Additive module (see docs/UPSTREAM-MERGE.md): does NOT patch node_modules or
 * add a pnpm `patchedDependencies` entry. The upstream adapter creates a Discord
 * thread whenever an incoming message mentions the bot (handleGatewayMessage /
 * handleForwardedMessage → createDiscordThread), with no config toggle to turn
 * it off. We neutralise it at the instance level: `createDiscordThread` has
 * exactly two callers, both the mention path, so overriding it to a no-op that
 * returns `{ id: undefined }` leaves `discordThreadId` unset → `encodeThreadId`
 * routes the reply to the root channel. No Discord API call is made, so there is
 * no failed-request error spam (unlike a permission-deny hack).
 *
 * On-demand threads are provided instead by the `/thread` slash command
 * (discord-features/thread-command.ts).
 */
import { log } from '../../log.js';

/**
 * Overwrite the adapter instance's `createDiscordThread` with a no-op. Defensive
 * against upstream shape changes: if the method is gone (upstream renamed/
 * removed it), we log and leave the adapter untouched rather than silently
 * masking a regression.
 */
export function suppressMentionAutoThread(adapter: unknown): void {
  const a = adapter as { createDiscordThread?: unknown };
  if (typeof a.createDiscordThread !== 'function') {
    log.warn(
      'suppress-mention-thread: adapter has no createDiscordThread method — upstream shape changed, skipping (auto-thread may be back)',
    );
    return;
  }
  (a as { createDiscordThread: (...args: unknown[]) => Promise<{ id: string | undefined }> }).createDiscordThread =
    async () => ({ id: undefined });
  log.info('suppress-mention-thread: auto-thread-on-mention disabled — mentions answer in the root channel');
}
