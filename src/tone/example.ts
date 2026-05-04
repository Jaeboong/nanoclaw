/**
 * Example tone override — English starter template.
 *
 * This file is tracked. Use it as a starting point for your own tone:
 *
 *   1. Copy:    cp src/tone/example.ts src/tone/<your-tone>.ts
 *   2. Edit:    replace strings to match your character/locale.
 *   3. Enable:  set NANOCLAW_TONE=<your-tone> in .env
 *   4. Build:   npm run build
 *
 * Override files are loaded dynamically at startup. Missing keys fall back
 * to NEUTRAL_MESSAGES in messages.ts. Personal/character tones (e.g. with
 * named emoji or character voice) should be gitignored — see .gitignore.
 *
 * Placeholders use `{name}` and are substituted via getMessage's second arg.
 */
import type { MessageKey } from './messages.js';

export const EMOJI = '📝';

export const MESSAGES: Partial<Record<MessageKey, string>> = {
  'jira.sync.ok': 'Sync complete.',
  'jira.sync.fail': 'Sync failed — check logs.',
  'jira.subtask.error': 'Failed to render subtasks — check logs.',
  'jira.subtask.empty': 'No open subtasks.',

  'workSync.ok': 'Work ledger (Jira / Non-Jira / Suggestions) synced.',

  'nonjira.edit.empty': 'Nothing to edit.',
  'nonjira.edit.pick': 'Pick one item to edit.',
  'nonjira.edit.gone': 'Item is gone.',
  'nonjira.edit.ok': 'Edited — `{side}` "{text}"',
  'nonjira.delete.empty': 'Nothing to delete.',
  'nonjira.delete.pick':
    'Pick items to delete — multi-select OK; check all {total} to wipe. (Deletes immediately.)',
  'nonjira.delete.summary': 'Deleted — {summary}',
  'nonjira.add.ok': 'Added — `{side}` "{text}"{rest}',
  'nonjira.add.autoNote': '(auto-classified)',
  'nonjira.promote.empty': 'Nothing to promote to Jira.',
  'nonjira.promote.pick':
    'Pick items to promote — multi-select OK; check all {total} to move everything. Created as `[FE]/[BE] text` Task and removed from Non-Jira.',
  'nonjira.promote.header': 'Created {n} Jira issue(s):',
  'nonjira.promote.emptyResult': 'Empty Jira response.',
  'nonjira.item.gone': 'Item is gone (already deleted).',

  'suggestion.gone': 'Suggestion is gone (already handled or removed).',
  'suggestion.goneShort': 'Suggestion is gone.',
  'suggestion.notTransition':
    'This suggestion is not a transition. Use Edit instead.',
  'suggestion.missingKey':
    'No matching Jira key. Use Edit to set the key, then apply.',
  'suggestion.apply.fail': 'Apply failed — `{error}`',
  'suggestion.apply.ok': 'Applied — `{key}` → **{status}**',
  'suggestion.delete.alreadyGone': 'Suggestion already gone.',
  'suggestion.delete.ok': 'Suggestion deleted.',
  'suggestion.edit.gone': 'Suggestion is gone.',
  'suggestion.edit.ok':
    'Suggestion edited — `{key}` → **{status}**. Hit Apply to commit.',

  'notes.empty.all':
    'No items yet {emoji}\nUse the **➕ Add** button below to register.',
  'notes.empty.filtered':
    'No items in `{filter}`. Pick another category.',
  'notes.list.truncated24': '(showing top 24 of {n})',
  'notes.list.truncated25': '(showing top 25 of {n})',
  'notes.list.empty': 'No items registered.',
  'notes.notFound': 'Item not found.',
  'notes.idNotFound': '#{id} not found',
  'notes.unknownChoice': 'Unknown choice.',
  'notes.unknownButton': 'Unknown button.',
  'notes.unknownModal': 'Unknown modal.',
  'notes.idParseFail': 'Failed to parse ID.',
  'notes.archive.empty': '_Archive is empty._',
  'notes.complete.ok': '{emoji} **#{padded}** marked complete, moved to archive.',
  'notes.delete.ok': '{emoji} **#{padded}** deleted.',
  'notes.add.ok': '{emoji} **#{padded}** added.',
  'notes.add.contentRequired': 'Content is required.',
  'notes.edit.ok': '{emoji} **#{padded}** edited.',
  'notes.opinion.ok':
    "{emoji} **{name}**'s opinion #{padded}{linked} recorded.",
  'notes.opinion.contentRequired': 'Opinion content is required.',
  'notes.opinion.linkParseFail': 'Failed to parse link ID.',
  'notes.opinion.linkNotFound': '#{padded} not found.',
  'notes.search.empty': 'No matches for `{kw}`.',
  'notes.search.queryRequired': 'Enter a search term.',
  'notes.error.generic': 'Error while processing.',
};
