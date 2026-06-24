import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel } from 'discord.js';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// Discord client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    // Needed to resolve users by name/nickname for pings.
    // Requires "Server Members Intent" to be enabled in the Discord Developer Portal.
    GatewayIntentBits.GuildMembers,
  ],
});

// Helper function to find a guild by name or ID
async function findGuild(guildIdentifier?: string) {
  if (!guildIdentifier) {
    // If no guild specified and bot is only in one guild, use that
    if (client.guilds.cache.size === 1) {
      return client.guilds.cache.first()!;
    }
    // List available guilds
    const guildList = Array.from(client.guilds.cache.values())
      .map(g => `"${g.name}"`).join(', ');
    throw new Error(`Bot is in multiple servers. Please specify server name or ID. Available servers: ${guildList}`);
  }

  // Try to fetch by ID first
  try {
    const guild = await client.guilds.fetch(guildIdentifier);
    if (guild) return guild;
  } catch {
    // If ID fetch fails, search by name
    const guilds = client.guilds.cache.filter(
      g => g.name.toLowerCase() === guildIdentifier.toLowerCase()
    );
    
    if (guilds.size === 0) {
      const availableGuilds = Array.from(client.guilds.cache.values())
        .map(g => `"${g.name}"`).join(', ');
      throw new Error(`Server "${guildIdentifier}" not found. Available servers: ${availableGuilds}`);
    }
    if (guilds.size > 1) {
      const guildList = guilds.map(g => `${g.name} (ID: ${g.id})`).join(', ');
      throw new Error(`Multiple servers found with name "${guildIdentifier}": ${guildList}. Please specify the server ID.`);
    }
    return guilds.first()!;
  }
  throw new Error(`Server "${guildIdentifier}" not found`);
}

// Helper function to find a channel by name or ID within a specific guild
async function findChannel(channelIdentifier: string, guildIdentifier?: string): Promise<TextChannel> {
  const guild = await findGuild(guildIdentifier);
  
  // First try to fetch by ID
  try {
    const channel = await client.channels.fetch(channelIdentifier);
    if (channel instanceof TextChannel && channel.guild.id === guild.id) {
      return channel;
    }
  } catch {
    // If fetching by ID fails, search by name in the specified guild
    const channels = guild.channels.cache.filter(
      (channel): channel is TextChannel =>
        channel instanceof TextChannel &&
        (channel.name.toLowerCase() === channelIdentifier.toLowerCase() ||
         channel.name.toLowerCase() === channelIdentifier.toLowerCase().replace('#', ''))
    );

    if (channels.size === 0) {
      const availableChannels = guild.channels.cache
        .filter((c): c is TextChannel => c instanceof TextChannel)
        .map(c => `"#${c.name}"`).join(', ');
      throw new Error(`Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}`);
    }
    if (channels.size > 1) {
      const channelList = channels.map(c => `#${c.name} (${c.id})`).join(', ');
      throw new Error(`Multiple channels found with name "${channelIdentifier}" in server "${guild.name}": ${channelList}. Please specify the channel ID.`);
    }
    return channels.first()!;
  }
  throw new Error(`Channel "${channelIdentifier}" is not a text channel or not found in server "${guild.name}"`);
}

// Resolve a role identifier (ID or name) to a role ID within a guild.
async function resolveRoleId(guild: import('discord.js').Guild, identifier: string): Promise<string> {
  const byId = guild.roles.cache.get(identifier);
  if (byId) return byId.id;
  const byName = guild.roles.cache.find(
    r => r.name.toLowerCase() === identifier.toLowerCase().replace(/^@&?/, '')
  );
  if (byName) return byName.id;
  const available = guild.roles.cache
    .filter(r => r.id !== guild.id)
    .map(r => `"${r.name}"`).join(', ');
  throw new Error(`Role "${identifier}" not found in "${guild.name}". Available roles: ${available}`);
}

// Resolve a user identifier (ID, username, tag, or nickname) to a member ID within a guild.
async function resolveUserId(guild: import('discord.js').Guild, identifier: string): Promise<string> {
  const clean = identifier.replace(/^@/, '');
  // Try direct ID fetch first.
  try {
    const member = await guild.members.fetch(clean);
    if (member) return member.id;
  } catch {
    // Not an ID — fall through to name/nickname search.
  }
  const matches = await guild.members.fetch({ query: clean, limit: 10 });
  const exact = matches.find(
    m => m.user.username.toLowerCase() === clean.toLowerCase() ||
         m.user.tag.toLowerCase() === clean.toLowerCase() ||
         (m.nickname?.toLowerCase() === clean.toLowerCase())
  );
  if (exact) return exact.id;
  if (matches.size === 1) return matches.first()!.id;
  if (matches.size > 1) {
    const list = matches.map(m => `${m.user.tag} (ID: ${m.id})`).join(', ');
    throw new Error(`Multiple members match "${identifier}": ${list}. Please specify the user ID.`);
  }
  throw new Error(`User "${identifier}" not found in "${guild.name}". Use find-member to search, or pass a user ID.`);
}

// Updated validation schemas
const SendMessageSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  message: z.string(),
  mentionUsers: z.array(z.string()).optional()
    .describe('Users to ping (IDs, usernames, tags, or nicknames). Mentions are prepended to the message.'),
  mentionRoles: z.array(z.string()).optional()
    .describe('Roles to ping (IDs or names). Role must be mentionable or the bot needs "Mention All Roles" permission.'),
  mentionEveryone: z.boolean().optional()
    .describe('Set true to ping @everyone (requires the bot to have the Mention Everyone permission).'),
});

const ReadMessagesSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  limit: z.number().min(1).max(100).default(50),
});

// Create server instance
const server = new Server(
  {
    name: "discord",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "send-message",
        description: "Send a message to a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            message: {
              type: "string",
              description: "Message content to send",
            },
          },
          required: ["channel", "message"],
        },
      },
      {
        name: "read-messages",
        description: "Read recent messages from a Discord channel",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: 'Channel name (e.g., "general") or ID',
            },
            limit: {
              type: "number",
              description: "Number of messages to fetch (max 100)",
              default: 50,
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "list-servers",
        description: "List all Discord servers (guilds) the bot is a member of. Use this first to discover available servers.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "list-channels",
        description: "List the text channels in a server. Use this to discover channel names before reading or sending messages.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
          },
        },
      },
      {
        name: "list-roles",
        description: "List the roles in a server (with IDs and whether each is mentionable). Use to discover roles before pinging them.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
          },
        },
      },
      {
        name: "find-member",
        description: "Search server members by username, tag, or nickname. Use to find a user's ID before pinging them.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            query: {
              type: "string",
              description: "Username, nickname, or tag to search for",
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "send-message": {
        const { server: guildIdentifier, channel: channelIdentifier, message, mentionUsers, mentionRoles, mentionEveryone } = SendMessageSchema.parse(args);
        const channel = await findChannel(channelIdentifier, guildIdentifier);

        // Resolve any requested mentions to IDs so Discord renders real pings.
        // Raw "@name" text never notifies anyone — only <@id> / <@&id> markup does.
        const userIds = await Promise.all((mentionUsers ?? []).map(u => resolveUserId(channel.guild, u)));
        const roleIds = await Promise.all((mentionRoles ?? []).map(r => resolveRoleId(channel.guild, r)));

        const prefix = [
          ...userIds.map(id => `<@${id}>`),
          ...roleIds.map(id => `<@&${id}>`),
          ...(mentionEveryone ? ['@everyone'] : []),
        ].join(' ');
        const content = prefix ? `${prefix} ${message}` : message;

        const sent = await channel.send({
          content,
          allowedMentions: {
            users: userIds,
            roles: roleIds,
            parse: mentionEveryone ? ['everyone'] : [],
          },
        });
        return {
          content: [{
            type: "text",
            text: `Message sent successfully to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}` +
              (prefix ? ` (pinged ${userIds.length} user(s), ${roleIds.length} role(s)${mentionEveryone ? ', @everyone' : ''})` : ''),
          }],
        };
      }

      case "read-messages": {
        const { server: guildIdentifier, channel: channelIdentifier, limit } = ReadMessagesSchema.parse(args);
        const channel = await findChannel(channelIdentifier, guildIdentifier);
        
        const messages = await channel.messages.fetch({ limit });
        const formattedMessages = Array.from(messages.values()).map(msg => ({
          channel: `#${channel.name}`,
          server: channel.guild.name,
          author: msg.author.tag,
          content: msg.content,
          timestamp: msg.createdAt.toISOString(),
        }));

        return {
          content: [{
            type: "text",
            text: JSON.stringify(formattedMessages, null, 2),
          }],
        };
      }

      case "list-servers": {
        const guilds = Array.from(client.guilds.cache.values())
          .map(g => ({ name: g.name, id: g.id }));
        return {
          content: [{
            type: "text",
            text: guilds.length
              ? JSON.stringify(guilds, null, 2)
              : "The bot is not a member of any servers.",
          }],
        };
      }

      case "list-channels": {
        const { server: guildIdentifier } = z
          .object({ server: z.string().optional() })
          .parse(args);
        const guild = await findGuild(guildIdentifier);
        const channels = guild.channels.cache
          .filter((c): c is TextChannel => c instanceof TextChannel)
          .map(c => ({ name: c.name, id: c.id }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ server: guild.name, channels }, null, 2),
          }],
        };
      }

      case "list-roles": {
        const { server: guildIdentifier } = z
          .object({ server: z.string().optional() })
          .parse(args);
        const guild = await findGuild(guildIdentifier);
        const roles = guild.roles.cache
          .filter(r => r.id !== guild.id) // exclude @everyone
          .sort((a, b) => b.position - a.position)
          .map(r => ({ name: r.name, id: r.id, mentionable: r.mentionable }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ server: guild.name, roles }, null, 2),
          }],
        };
      }

      case "find-member": {
        const { server: guildIdentifier, query } = z
          .object({ server: z.string().optional(), query: z.string() })
          .parse(args);
        const guild = await findGuild(guildIdentifier);
        const members = await guild.members.fetch({ query, limit: 10 });
        const results = members.map(m => ({
          id: m.id,
          username: m.user.username,
          tag: m.user.tag,
          nickname: m.nickname ?? null,
        }));
        return {
          content: [{
            type: "text",
            text: results.length
              ? JSON.stringify(results, null, 2)
              : `No members found matching "${query}" in "${guild.name}".`,
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // Return errors as readable tool content (isError) rather than throwing a
    // protocol-level error, so the client/model can see the message — including
    // the list of available servers/channels — and recover or ask the user.
    const message = error instanceof z.ZodError
      ? `Invalid arguments: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
      : error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }
});

// Discord client login and error handling
client.once('ready', () => {
  console.error('Discord bot is ready!');
});

// Start the server
async function main() {
  // Check for Discord token
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error('DISCORD_TOKEN environment variable is not set');
  }
  
  try {
    // Login to Discord
    await client.login(token);

    // Start MCP server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Discord MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error in main():", error);
    process.exit(1);
  }
}

main();