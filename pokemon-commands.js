// ─── Pokemon Command Definitions ─────────────────────────────────────────────
// All pokemon slash commands — registered together with clan commands by index.js

const { SlashCommandBuilder } = require('discord.js');

module.exports = function getPokemonCommands() {
  return [
    new SlashCommandBuilder()
      .setName('pokemon-team')
      .setDescription('View your personal Pokémon collection'),

    new SlashCommandBuilder()
      .setName('pokemon-stats')
      .setDescription('View detailed stats and XP bar for one of your Pokémon')
      .addIntegerOption(o => o.setName('slot').setDescription('Slot number from /pokemon-team').setRequired(true).setMinValue(1).setMaxValue(30)),

    new SlashCommandBuilder()
      .setName('pokemon-view')
      .setDescription('View another player\'s Pokémon collection')
      .addUserOption(o => o.setName('user').setDescription('The player to view').setRequired(true)),

    new SlashCommandBuilder()
      .setName('pokemon-release')
      .setDescription('Release one of your Pokémon')
      .addIntegerOption(o => o.setName('slot').setDescription('Slot number from /pokemon-team').setRequired(true).setMinValue(1).setMaxValue(30)),

    new SlashCommandBuilder()
      .setName('pokemon-nickname')
      .setDescription('Give one of your Pokémon a nickname')
      .addIntegerOption(o => o.setName('slot').setDescription('Slot number from /pokemon-team').setRequired(true).setMinValue(1).setMaxValue(30))
      .addStringOption(o => o.setName('name').setDescription('Nickname (max 20 chars)').setRequired(true)),

    new SlashCommandBuilder()
      .setName('pokemon-info')
      .setDescription('Look up any Pokémon using the PokéAPI')
      .addStringOption(o => o.setName('pokemon').setDescription('Pokémon name or number').setRequired(true)),

    new SlashCommandBuilder()
      .setName('pokemon-bag')
      .setDescription('View your item bag'),

    new SlashCommandBuilder()
      .setName('pokemon-claim')
      .setDescription('Claim an active item drop in your clan channel'),

    new SlashCommandBuilder()
      .setName('pokemon-challenge')
      .setDescription('Challenge another clan member to a Pokémon battle')
      .addUserOption(o => o.setName('user').setDescription('The member to challenge').setRequired(true))
      .addIntegerOption(o => o.setName('slot').setDescription('Your Pokémon slot to use').setRequired(true).setMinValue(1).setMaxValue(30)),

    new SlashCommandBuilder()
      .setName('pokemon-accept')
      .setDescription('Accept a pending Pokémon battle challenge')
      .addIntegerOption(o => o.setName('slot').setDescription('Your Pokémon slot to use').setRequired(true).setMinValue(1).setMaxValue(30)),

    new SlashCommandBuilder()
      .setName('pokemon-decline')
      .setDescription('Decline a pending Pokémon battle challenge'),

    new SlashCommandBuilder()
      .setName('pokemon-leaderboard')
      .setDescription('View the Pokémon leaderboard for your clan'),

    new SlashCommandBuilder()
      .setName('pokemon-server')
      .setDescription('View top Pokémon across the entire server ranked by battle wins'),

    new SlashCommandBuilder()
      .setName('pokedex')
      .setDescription('View your clan\'s Pokédex — species caught vs encountered'),

    new SlashCommandBuilder()
      .setName('pokemon-spawn')
      .setDescription('Force a Pokémon to spawn in a clan channel — Admin only')
      .addChannelOption(o => o.setName('channel').setDescription('The clan channel to spawn in').setRequired(false)),

  ].map(c => c.toJSON());
};
