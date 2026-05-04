import {
  type ButtonInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';

import { logger } from '../../logger.js';
import {
  handleWorkInteraction,
  handleWorkModal,
  handleWorkSelect,
  refreshAllPanels,
  refreshNonJiraPanel,
  refreshSuggestionsPanel,
} from '../discord-work-ui.js';

import type {
  DiscordFeature,
  DiscordFeatureContext,
  SlashCommandJSON,
} from './feature.js';

export interface JiraFeature extends DiscordFeature {
  refreshAllPanels(): Promise<boolean>;
  refreshSuggestionsPanel(): Promise<boolean>;
  refreshNonJiraPanel(): Promise<boolean>;
}

export interface JiraFeatureConfig {
  /**
   * Raw Discord channel ID (no `dc:` prefix) where the three pinned panels —
   * Jira ledger / Non-Jira / Suggestions — are rendered. The bot bound to this
   * feature must have access to this channel.
   */
  panelChannelId: string;
}

export function createJiraFeature(config: JiraFeatureConfig): JiraFeature {
  const { panelChannelId } = config;
  let _client: Client | null = null;

  const ensureClient = (): Client | null => _client;

  const slashCommands = (): SlashCommandJSON[] => [];

  const handleButton = async (
    interaction: ButtonInteraction,
    _ctx: DiscordFeatureContext,
  ): Promise<boolean> => {
    if (!interaction.customId.startsWith('work:')) return false;
    try {
      const result = await handleWorkInteraction(interaction, panelChannelId);
      return result.handled;
    } catch (err) {
      logger.error({ err }, 'Work button interaction failed');
      return true;
    }
  };

  const handleSelect = async (
    interaction: StringSelectMenuInteraction,
    _ctx: DiscordFeatureContext,
  ): Promise<boolean> => {
    if (!interaction.customId.startsWith('work:')) return false;
    try {
      const result = await handleWorkSelect(interaction, panelChannelId);
      return result.handled;
    } catch (err) {
      logger.error({ err }, 'Work select interaction failed');
      return true;
    }
  };

  const handleModal = async (
    interaction: ModalSubmitInteraction,
    _ctx: DiscordFeatureContext,
  ): Promise<boolean> => {
    if (!interaction.customId.startsWith('work:')) return false;
    try {
      const result = await handleWorkModal(interaction, panelChannelId);
      return result.handled;
    } catch (err) {
      logger.error({ err }, 'Work modal interaction failed');
      return true;
    }
  };

  return {
    name: 'jira',
    slashCommands,
    handleButton,
    handleSelect,
    handleModal,
    onReady: async ({ client }) => {
      _client = client;
    },
    refreshAllPanels: async () => {
      const c = ensureClient();
      if (!c) return false;
      return refreshAllPanels(c, panelChannelId);
    },
    refreshSuggestionsPanel: async () => {
      const c = ensureClient();
      if (!c) return false;
      return refreshSuggestionsPanel(c, panelChannelId);
    },
    refreshNonJiraPanel: async () => {
      const c = ensureClient();
      if (!c) return false;
      return refreshNonJiraPanel(c, panelChannelId);
    },
  };
}
