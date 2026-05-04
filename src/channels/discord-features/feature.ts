import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ModalSubmitInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
  StringSelectMenuInteraction,
} from 'discord.js';

import type {
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../../types.js';

export type SlashCommandJSON =
  RESTPostAPIChatInputApplicationCommandsJSONBody;

export interface DiscordFeatureContext {
  readonly client: Client;
  readonly registeredGroups: () => Record<string, RegisteredGroup>;
  readonly onMessage: OnInboundMessage;
  readonly onChatMetadata: OnChatMetadata;
}

export interface DiscordFeature {
  readonly name: string;
  slashCommands(): readonly SlashCommandJSON[];
  handleCommand?(
    interaction: ChatInputCommandInteraction,
    ctx: DiscordFeatureContext,
  ): Promise<boolean>;
  handleButton?(
    interaction: ButtonInteraction,
    ctx: DiscordFeatureContext,
  ): Promise<boolean>;
  handleSelect?(
    interaction: StringSelectMenuInteraction,
    ctx: DiscordFeatureContext,
  ): Promise<boolean>;
  handleModal?(
    interaction: ModalSubmitInteraction,
    ctx: DiscordFeatureContext,
  ): Promise<boolean>;
  onReady?(ctx: { client: Client }): Promise<void>;
}
