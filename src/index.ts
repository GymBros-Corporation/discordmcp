import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from 'dotenv';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Client, GatewayIntentBits, TextChannel, ThreadChannel, ChannelType, PermissionFlagsBits, SnowflakeUtil, Message, type GuildTextBasedChannel } from 'discord.js';
import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, isAbsolute } from 'path';

// Load environment variables
dotenv.config();

// Write data to an absolute path on disk so large pulls can be computed on
// outside of the model's context (avoids hand-transcribing big JSON blobs).
function writeJsonFile(outputFile: string, data: unknown): { path: string; bytes: number } {
  if (!isAbsolute(outputFile)) {
    throw new Error(`outputFile must be an absolute path (e.g. /Users/you/discord-export.json). Got "${outputFile}".`);
  }
  mkdirSync(dirname(outputFile), { recursive: true });
  const json = JSON.stringify(data, null, 2);
  writeFileSync(outputFile, json, 'utf8');
  return { path: outputFile, bytes: Buffer.byteLength(json) };
}

// Gather a channel's threads (active + archived) so analysis can include the
// back-and-forth that lives inside threads/forum posts, not just top-level chat.
async function getChannelThreads(guild: import('discord.js').Guild, parent: any): Promise<ThreadChannel[]> {
  const out: ThreadChannel[] = [];
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  if (active) {
    for (const t of active.threads.values()) {
      if (t.parentId === parent.id) out.push(t);
    }
  }
  if (parent && 'threads' in parent && parent.threads?.fetchArchived) {
    const arch = await parent.threads.fetchArchived({ limit: 100 }).catch(() => null);
    if (arch) for (const t of arch.threads.values()) out.push(t as ThreadChannel);
  }
  return out;
}

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

// A channel we can read/send messages in: text channels, announcement channels,
// and threads (including forum posts). Excludes forum/voice containers and DMs.
type MessageableChannel = GuildTextBasedChannel | ThreadChannel;

function isMessageable(channel: unknown, guildId: string): boolean {
  const c = channel as any;
  return !!c && typeof c.isTextBased === 'function' && c.isTextBased() && !c.isDMBased() && c.guildId === guildId;
}

// Find a readable channel by ID or name within a guild. Accepts text channels
// AND threads — a thread's ID is addressable just like a channel's (and equals
// its starter message ID for forum/message threads).
async function findChannel(channelIdentifier: string, guildIdentifier?: string): Promise<MessageableChannel> {
  const guild = await findGuild(guildIdentifier);

  // Try by ID first (works for text channels and threads alike).
  try {
    const channel = await client.channels.fetch(channelIdentifier);
    if (isMessageable(channel, guild.id)) return channel as MessageableChannel;
  } catch {
    // Not a resolvable ID — fall through to name search.
  }

  const lower = channelIdentifier.toLowerCase().replace('#', '');

  // Search cached channels and active threads by name.
  const named = guild.channels.cache.filter(
    c => isMessageable(c, guild.id) && c.name.toLowerCase() === lower
  );
  if (named.size === 1) return named.first()! as MessageableChannel;
  if (named.size > 1) {
    const list = named.map(c => `#${c.name} (${c.id})`).join(', ');
    throw new Error(`Multiple channels named "${channelIdentifier}" in "${guild.name}": ${list}. Please specify the channel/thread ID.`);
  }

  // Active threads aren't always in the channel cache — check them explicitly.
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  const namedThread = active?.threads.find(t => t.name.toLowerCase() === lower);
  if (namedThread) return namedThread;

  const availableChannels = guild.channels.cache
    .filter(c => isMessageable(c, guild.id))
    .map(c => `"#${c.name}"`).join(', ');
  throw new Error(`Channel "${channelIdentifier}" not found in server "${guild.name}". Available channels: ${availableChannels}. (For threads, use list-threads to get the thread ID, or pass the thread ID directly.)`);
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

// Format a Discord message into a rich, analysis-friendly object that includes
// author IDs, reply references, and mentions — so callers don't need extra
// round-trips (e.g. find-member) to identify who said or was pinged in what.
function formatMessage(channel: MessageableChannel, msg: Message) {
  return {
    id: msg.id,
    channel: `#${channel.name}`,
    channelId: channel.id,
    server: channel.guild.name,
    author: msg.author.tag,
    authorId: msg.author.id,
    authorDisplayName: msg.member?.displayName ?? msg.author.username,
    isBot: msg.author.bot,
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    editedTimestamp: msg.editedAt ? msg.editedAt.toISOString() : null,
    replyToMessageId: msg.reference?.messageId ?? null,
    mentions: {
      users: msg.mentions.users.map(u => ({ id: u.id, tag: u.tag })),
      roles: msg.mentions.roles.map(r => ({ id: r.id, name: r.name })),
    },
  };
}

// Does a message match an author filter (ID, username, tag, or nickname)?
function authorMatches(msg: Message, author?: string): boolean {
  if (!author) return true;
  const a = author.toLowerCase().replace(/^@/, '');
  return (
    msg.author.id === author ||
    msg.author.username.toLowerCase() === a ||
    msg.author.tag.toLowerCase() === a ||
    msg.member?.displayName?.toLowerCase() === a ||
    msg.member?.nickname?.toLowerCase() === a
  );
}

// Convert an ISO 8601 timestamp into a Discord snowflake for use as a
// before/after history bound (snowflakes encode their creation time).
function timestampToSnowflake(iso: string): string {
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date "${iso}". Use an ISO 8601 string, e.g. "2025-06-01T00:00:00Z".`);
  }
  return SnowflakeUtil.generate({ timestamp: ms }).toString();
}

interface CollectOptions {
  limit: number;                          // max messages to RETURN (after filters)
  before?: string;                        // message ID upper bound (older than)
  after?: string;                         // message ID lower bound (newer than)
  since?: string;                         // ISO timestamp lower bound
  until?: string;                         // ISO timestamp upper bound
  author?: string;                        // author filter
  contentMatch?: (content: string) => boolean; // keyword predicate (search)
  maxScan?: number;                       // safety cap on messages fetched
}

// Fetch channel history with pagination + filtering. Walks backward (newest to
// oldest) in batches of 100, applying author/time/keyword filters, until it has
// `limit` matches or hits the scan cap. Returns messages newest-first.
async function collectMessages(channel: MessageableChannel, opts: CollectOptions) {
  const maxScan = opts.maxScan ?? 3000;

  // Upper bound (older-than cursor): the smaller of `before` and `until`.
  let cursor = opts.before;
  if (opts.until) {
    const untilId = timestampToSnowflake(opts.until);
    cursor = cursor ? (BigInt(cursor) < BigInt(untilId) ? cursor : untilId) : untilId;
  }
  // Lower bound (stop when we reach it): the larger of `after` and `since`.
  let lowerBound: bigint | null = opts.after ? BigInt(opts.after) : null;
  if (opts.since) {
    const sinceId = BigInt(timestampToSnowflake(opts.since));
    lowerBound = lowerBound !== null && lowerBound > sinceId ? lowerBound : sinceId;
  }

  const results: ReturnType<typeof formatMessage>[] = [];
  let scanned = 0;
  let reachedLowerBound = false;

  while (results.length < opts.limit && scanned < maxScan) {
    const batchSize = Math.min(100, maxScan - scanned);
    const batch = await channel.messages.fetch({
      limit: batchSize,
      ...(cursor ? { before: cursor } : {}),
    });
    if (batch.size === 0) break;

    const ordered = [...batch.values()]; // newest -> oldest
    for (const msg of ordered) {
      scanned++;
      if (lowerBound !== null && BigInt(msg.id) <= lowerBound) { reachedLowerBound = true; break; }
      if (!authorMatches(msg, opts.author)) continue;
      if (opts.contentMatch && !opts.contentMatch(msg.content)) continue;
      results.push(formatMessage(channel, msg));
      if (results.length >= opts.limit) break;
    }

    cursor = ordered[ordered.length - 1].id; // oldest id seen, for next page
    if (reachedLowerBound || batch.size < batchSize) break;
  }

  return { messages: results, scanned, hitScanCap: scanned >= maxScan && results.length < opts.limit };
}

// Resolve a channel that can CONTAIN threads (text, announcement, or forum) by
// ID or name. Unlike findChannel, this accepts forum channels (which aren't
// message-readable themselves but hold thread/post children).
async function resolveThreadParent(guild: import('discord.js').Guild, identifier: string) {
  const hasThreads = (c: any) => c && c.guildId === guild.id && 'threads' in c && c.threads;
  const byId = guild.channels.cache.get(identifier)
    ?? await client.channels.fetch(identifier).catch(() => null);
  if (hasThreads(byId)) return byId as any;

  const lower = identifier.toLowerCase().replace('#', '');
  const byName = guild.channels.cache.find(c => hasThreads(c) && c.name?.toLowerCase() === lower);
  if (byName) return byName as any;

  const candidates = guild.channels.cache
    .filter(c => hasThreads(c))
    .map(c => `"#${c.name}"`).join(', ');
  throw new Error(`Channel "${identifier}" not found or can't contain threads in "${guild.name}". Channels that hold threads: ${candidates}`);
}

function threadInfo(t: ThreadChannel, archivedHint = false) {
  return {
    id: t.id,
    name: t.name,
    parentId: t.parentId,
    parentName: t.parent?.name ?? null,
    archived: t.archived ?? archivedHint,
    messageCount: t.messageCount ?? null,
    ownerId: t.ownerId ?? null,
    createdTimestamp: t.createdAt ? t.createdAt.toISOString() : null,
    lastMessageId: t.lastMessageId ?? null,
  };
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
  limit: z.number().min(1).max(1000).default(50)
    .describe('Max messages to return. Values over 100 are fetched via pagination.'),
  before: z.string().optional().describe('Only messages older than this message ID (cursor for paging back through history).'),
  after: z.string().optional().describe('Only messages newer than this message ID.'),
  since: z.string().optional().describe('Only messages at/after this ISO 8601 timestamp, e.g. "2025-06-01T00:00:00Z".'),
  until: z.string().optional().describe('Only messages at/before this ISO 8601 timestamp.'),
  author: z.string().optional().describe('Filter to a single author (ID, username, tag, or nickname).'),
  outputFile: z.string().optional()
    .describe('Absolute path. If set, full results are written to this file as JSON and only a summary + path is returned (use for large pulls you need to compute on).'),
});

const SearchMessagesSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().optional().describe('Channel name or ID to search. Omit to search all readable text channels in the server.'),
  query: z.string().describe('Keyword(s) to find. Space-separated terms must ALL appear in a message (case-insensitive).'),
  limit: z.number().min(1).max(200).default(25).describe('Max matching messages to return.'),
  author: z.string().optional().describe('Restrict to a single author (ID, username, tag, or nickname).'),
  since: z.string().optional().describe('Only search messages at/after this ISO 8601 timestamp.'),
  until: z.string().optional().describe('Only search messages at/before this ISO 8601 timestamp.'),
  includeThreads: z.boolean().optional()
    .describe('Also search inside threads/forum posts of each channel (slower but complete).'),
  maxScanPerChannel: z.number().min(1).max(5000).default(1000)
    .describe('Max messages to scan per channel before giving up (keyword search reads history client-side).'),
  outputFile: z.string().optional()
    .describe('Absolute path. If set, full matches are written to this file as JSON and only a summary + path is returned.'),
});

const ExportChannelSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().describe('Channel name or ID to export. Works for text channels and forum channels.'),
  outputFile: z.string().describe('Absolute path to write the full export to (JSON).'),
  includeThreads: z.boolean().default(true).describe('Include all threads/forum posts under the channel (default true).'),
  maxMessages: z.number().min(1).max(20000).default(5000).describe('Safety cap on total messages fetched per channel/thread.'),
  since: z.string().optional().describe('Only messages at/after this ISO 8601 timestamp.'),
  until: z.string().optional().describe('Only messages at/before this ISO 8601 timestamp.'),
  author: z.string().optional().describe('Optionally restrict to a single author (omit for the full all-author timeline needed for adjacency).'),
});

const CheckAccessSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
});

const ListThreadsSchema = z.object({
  server: z.string().optional().describe('Server name or ID (optional if bot is only in one server)'),
  channel: z.string().optional().describe('Parent channel name or ID (text or forum). Omit to list all active threads in the server.'),
  includeArchived: z.boolean().optional().describe('Also include archived threads. Requires a parent channel; fetched per-channel (up to 100).'),
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
            mentionUsers: {
              type: "array",
              items: { type: "string" },
              description: "Users to ping (IDs, usernames, tags, or nicknames). Resolved to real mentions and prepended to the message.",
            },
            mentionRoles: {
              type: "array",
              items: { type: "string" },
              description: 'Roles to ping (IDs or names). Role must be mentionable or the bot needs "Mention All Roles" permission.',
            },
            mentionEveryone: {
              type: "boolean",
              description: "Set true to ping @everyone (requires the bot to have the Mention Everyone permission).",
            },
          },
          required: ["channel", "message"],
        },
      },
      {
        name: "read-messages",
        description: "Read messages from a Discord channel OR thread (pass a thread ID as `channel`). Each message includes author ID, reply reference, and mentions. Supports pagination (limit up to 1000) and before/after/since/until/author filters for full-history analysis.",
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
              description: "Max messages to return (up to 1000; values over 100 are paginated automatically)",
              default: 50,
            },
            before: {
              type: "string",
              description: "Only messages older than this message ID (cursor for paging back through history)",
            },
            after: {
              type: "string",
              description: "Only messages newer than this message ID",
            },
            since: {
              type: "string",
              description: 'Only messages at/after this ISO 8601 timestamp, e.g. "2025-06-01T00:00:00Z"',
            },
            until: {
              type: "string",
              description: "Only messages at/before this ISO 8601 timestamp",
            },
            author: {
              type: "string",
              description: "Filter to a single author (ID, username, tag, or nickname)",
            },
            outputFile: {
              type: "string",
              description: "Absolute path. If set, full results are written here as JSON and only a summary + path is returned (use for large pulls you need to compute on).",
            },
          },
          required: ["channel"],
        },
      },
      {
        name: "search-messages",
        description: "Keyword-search messages in a channel (or across all readable channels in a server). Space-separated terms must all appear. Returns matches with author IDs and timestamps.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: "Channel name or ID to search. Omit to search all readable text channels in the server.",
            },
            query: {
              type: "string",
              description: "Keyword(s) to find. Space-separated terms must ALL appear (case-insensitive).",
            },
            limit: {
              type: "number",
              description: "Max matching messages to return",
              default: 25,
            },
            author: {
              type: "string",
              description: "Restrict to a single author (ID, username, tag, or nickname)",
            },
            since: {
              type: "string",
              description: "Only search messages at/after this ISO 8601 timestamp",
            },
            until: {
              type: "string",
              description: "Only search messages at/before this ISO 8601 timestamp",
            },
            includeThreads: {
              type: "boolean",
              description: "Also search inside threads/forum posts of each channel (slower but complete).",
            },
            maxScanPerChannel: {
              type: "number",
              description: "Max messages to scan per channel before giving up",
              default: 1000,
            },
            outputFile: {
              type: "string",
              description: "Absolute path. If set, full matches are written here as JSON and only a summary + path is returned.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "export-channel",
        description: "Export a channel's FULL all-author timeline (and, by default, all its threads/forum posts) to a JSON file on disk, sorted oldest->newest. Use for large-scale analysis (e.g. adjacency-based response times) that can't be computed inside context.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: 'Server name or ID (optional if bot is only in one server)' },
            channel: { type: "string", description: "Channel name or ID to export (text or forum channel)" },
            outputFile: { type: "string", description: "Absolute path to write the JSON export to" },
            includeThreads: { type: "boolean", description: "Include all threads/forum posts under the channel (default true)", default: true },
            maxMessages: { type: "number", description: "Safety cap on messages fetched per channel/thread", default: 5000 },
            since: { type: "string", description: "Only messages at/after this ISO 8601 timestamp" },
            until: { type: "string", description: "Only messages at/before this ISO 8601 timestamp" },
            author: { type: "string", description: "Optionally restrict to one author (omit for the full all-author timeline needed for adjacency)" },
          },
          required: ["channel", "outputFile"],
        },
      },
      {
        name: "check-access",
        description: "Report which text/announcement/forum channels the bot can actually read (View Channel + Read Message History). Use to find the gaps behind 'Missing Access' errors so they can be granted in Discord.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string", description: 'Server name or ID (optional if bot is only in one server)' },
          },
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
        description: "List text, announcement, and forum channels in a server (each with its type). Forum channels hold threads/posts — pass one to list-threads. Use threads via list-threads, not this.",
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
        name: "list-threads",
        description: "List threads (active, and optionally archived) — including forum posts and message side-conversations. Returns thread IDs you can pass to read-messages. Omit channel to list all active threads in the server.",
        inputSchema: {
          type: "object",
          properties: {
            server: {
              type: "string",
              description: 'Server name or ID (optional if bot is only in one server)',
            },
            channel: {
              type: "string",
              description: "Parent channel name or ID (text or forum). Omit to list all active threads in the server.",
            },
            includeArchived: {
              type: "boolean",
              description: "Also include archived threads (requires a parent channel; up to 100).",
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

        // Also honor mention markup already present in the message text. Without
        // this, an explicit allowedMentions list would render those pills but
        // suppress their notifications. Merge embedded IDs into the allow-list.
        const embeddedUserIds = [...content.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
        const embeddedRoleIds = [...content.matchAll(/<@&(\d+)>/g)].map(m => m[1]);
        const allUserIds = [...new Set([...userIds, ...embeddedUserIds])];
        const allRoleIds = [...new Set([...roleIds, ...embeddedRoleIds])];
        const pingEveryone = mentionEveryone || /@(everyone|here)/.test(content);

        const sent = await channel.send({
          content,
          allowedMentions: {
            users: allUserIds,
            roles: allRoleIds,
            parse: pingEveryone ? ['everyone'] : [],
          },
        });
        return {
          content: [{
            type: "text",
            text: `Message sent successfully to #${channel.name} in ${channel.guild.name}. Message ID: ${sent.id}` +
              ((allUserIds.length || allRoleIds.length || pingEveryone)
                ? ` (pinged ${allUserIds.length} user(s), ${allRoleIds.length} role(s)${pingEveryone ? ', @everyone' : ''})`
                : ''),
          }],
        };
      }

      case "read-messages": {
        const { server: guildIdentifier, channel: channelIdentifier, limit, before, after, since, until, author, outputFile } = ReadMessagesSchema.parse(args);
        const channel = await findChannel(channelIdentifier, guildIdentifier);

        const { messages, scanned, hitScanCap } = await collectMessages(channel, {
          limit, before, after, since, until, author,
          // Scan deeper when filtering (matches may be sparse); otherwise scan
          // only as far as needed to return `limit` messages.
          maxScan: (author || since || after) ? 3000 : Math.max(limit, 100),
        });

        const capNote = hitScanCap
          ? `Stopped after scanning ${scanned} messages (safety cap). Narrow with since/until/author, or page further back using 'before' with the oldest message id.`
          : undefined;

        // For large pulls, write to disk and return only a summary so the data
        // can be computed on without flooding (or being re-transcribed from) context.
        if (outputFile) {
          const { path, bytes } = writeJsonFile(outputFile, { source: `#${channel.name}`, count: messages.length, messages });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                wroteFile: path,
                bytes,
                count: messages.length,
                newest: messages[0]?.timestamp ?? null,
                oldest: messages[messages.length - 1]?.timestamp ?? null,
                ...(capNote ? { note: capNote } : {}),
              }, null, 2),
            }],
          };
        }

        const payload: any = { count: messages.length, messages };
        if (capNote) payload.note = capNote;
        return {
          content: [{
            type: "text",
            text: JSON.stringify(payload, null, 2),
          }],
        };
      }

      case "search-messages": {
        const { server: guildIdentifier, channel: channelIdentifier, query, limit, author, since, until, includeThreads, maxScanPerChannel, outputFile } = SearchMessagesSchema.parse(args);
        const guild = await findGuild(guildIdentifier);

        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        const contentMatch = (content: string) => {
          const lc = content.toLowerCase();
          return terms.every(t => lc.includes(t));
        };

        // Build the list of targets to scan: requested channel (or all text
        // channels), plus their threads when includeThreads is set.
        const targets: MessageableChannel[] = channelIdentifier
          ? [await findChannel(channelIdentifier, guildIdentifier)]
          : [...guild.channels.cache.filter((c): c is TextChannel => c instanceof TextChannel).values()];
        if (includeThreads) {
          const parents = channelIdentifier
            ? [await resolveThreadParent(guild, channelIdentifier).catch(() => null)].filter(Boolean)
            : [...guild.channels.cache.filter(c => 'threads' in c && (c as any).threads).values()];
          for (const p of parents) {
            const threads = await getChannelThreads(guild, p);
            targets.push(...threads);
          }
        }

        const matches: ReturnType<typeof formatMessage>[] = [];
        const channelsScanned: { channel: string; scanned: number; matched: number; hitScanCap: boolean; error?: string }[] = [];
        const missingAccess: string[] = [];

        for (const ch of targets) {
          if (matches.length >= limit) break;
          try {
            const { messages, scanned, hitScanCap } = await collectMessages(ch, {
              limit: limit - matches.length,
              author, since, until, contentMatch,
              maxScan: maxScanPerChannel,
            });
            matches.push(...messages);
            channelsScanned.push({ channel: `#${ch.name}`, scanned, matched: messages.length, hitScanCap });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Surface no-access channels distinctly so the gap is actionable.
            if (/missing access|read message history|50001|50013/i.test(msg)) missingAccess.push(`#${ch.name}`);
            channelsScanned.push({ channel: `#${ch.name}`, scanned: 0, matched: 0, hitScanCap: false, error: msg });
          }
        }

        if (outputFile) {
          const { path, bytes } = writeJsonFile(outputFile, { query, totalMatches: matches.length, matches, channelsScanned });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                wroteFile: path, bytes, query, totalMatches: matches.length,
                channelsScanned: channelsScanned.length,
                ...(missingAccess.length ? { missingAccess } : {}),
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              query,
              totalMatches: matches.length,
              matches,
              channelsScanned,
              ...(missingAccess.length ? { missingAccess, accessNote: "The bot lacks View Channel / Read Message History on these. Grant it those permissions (or add it to the private channel) in Discord — this is server-side, not the connector." } : {}),
              note: "Keyword (substring) search over recent history. Increase maxScanPerChannel to look further back; channels showing hitScanCap=true may have older matches.",
            }, null, 2),
          }],
        };
      }

      case "export-channel": {
        const { server: guildIdentifier, channel: channelIdentifier, outputFile, includeThreads, maxMessages, since, until, author } = ExportChannelSchema.parse(args);
        const guild = await findGuild(guildIdentifier);

        const sources: { source: string; id: string; kind: string }[] = [];
        const allMessages: ReturnType<typeof formatMessage>[] = [];
        let parentForThreads: any = null;
        let label = channelIdentifier;

        // The channel itself (a forum has no top-level messages — only threads).
        try {
          const ch = await findChannel(channelIdentifier, guildIdentifier);
          label = `#${ch.name}`;
          const { messages } = await collectMessages(ch, { limit: maxMessages, since, until, author, maxScan: maxMessages });
          allMessages.push(...messages);
          sources.push({ source: `#${ch.name}`, id: ch.id, kind: 'channel' });
          parentForThreads = ('threads' in ch && (ch as any).threads) ? ch : null;
        } catch {
          parentForThreads = await resolveThreadParent(guild, channelIdentifier);
          label = `#${parentForThreads.name}`;
        }

        if (includeThreads && parentForThreads) {
          const threads = await getChannelThreads(guild, parentForThreads);
          for (const t of threads) {
            try {
              const { messages } = await collectMessages(t, { limit: maxMessages, since, until, author, maxScan: maxMessages });
              allMessages.push(...messages);
              sources.push({ source: `thread:${t.name}`, id: t.id, kind: 'thread' });
            } catch { /* skip unreadable thread */ }
          }
        }

        // Sort oldest -> newest so the file is a clean timeline for adjacency math.
        allMessages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

        const { path, bytes } = writeJsonFile(outputFile, {
          server: guild.name, channel: label, exportedSources: sources,
          totalMessages: allMessages.length, messages: allMessages,
        });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              wroteFile: path, bytes, channel: label,
              totalMessages: allMessages.length,
              sources: sources.length,
              threadsIncluded: sources.filter(s => s.kind === 'thread').length,
              newest: allMessages[allMessages.length - 1]?.timestamp ?? null,
              oldest: allMessages[0]?.timestamp ?? null,
              note: "Full all-author timeline (channel + threads) written to disk, sorted oldest->newest. Ready for adjacency-based response-time computation.",
            }, null, 2),
          }],
        };
      }

      case "check-access": {
        const { server: guildIdentifier } = CheckAccessSchema.parse(args);
        const guild = await findGuild(guildIdentifier);
        const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);

        const relevant = guild.channels.cache.filter(c =>
          c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement ||
          c.type === ChannelType.GuildForum
        );
        const report = relevant.map(c => {
          const perms = me ? c.permissionsFor(me) : null;
          const canView = perms?.has(PermissionFlagsBits.ViewChannel) ?? false;
          const canReadHistory = perms?.has(PermissionFlagsBits.ReadMessageHistory) ?? false;
          return { name: `#${c.name}`, id: c.id, type: ChannelType[c.type], canView, canReadHistory, readable: canView && canReadHistory };
        });
        const unreadable = report.filter(r => !r.readable);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              server: guild.name,
              totalChannels: report.length,
              readableChannels: report.filter(r => r.readable).length,
              unreadable,
              note: unreadable.length
                ? "Unreadable channels need 'View Channel' + 'Read Message History' granted to the bot (or the bot added to the private channel). This is a Discord server-side permission change, not a connector fix."
                : "Bot can read all text/forum channels in this server.",
            }, null, 2),
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
        // Include text, announcement, and forum channels. Forum channels aren't
        // directly readable but hold threads/posts — surface them so callers can
        // pass them to list-threads. Threads themselves are listed separately.
        const channels = guild.channels.cache
          .filter(c =>
            c.type === ChannelType.GuildText ||
            c.type === ChannelType.GuildAnnouncement ||
            c.type === ChannelType.GuildForum
          )
          .map(c => ({ name: c.name, id: c.id, type: ChannelType[c.type] }));
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ server: guild.name, channels }, null, 2),
          }],
        };
      }

      case "list-threads": {
        const { server: guildIdentifier, channel: parentIdentifier, includeArchived } = ListThreadsSchema.parse(args);
        const guild = await findGuild(guildIdentifier);

        const parentId = parentIdentifier ? (await resolveThreadParent(guild, parentIdentifier)).id : null;

        // Active threads are fetched guild-wide, then filtered by parent if given.
        const activeRes = await guild.channels.fetchActiveThreads();
        const threads = activeRes.threads
          .filter(t => !parentId || t.parentId === parentId)
          .map(t => threadInfo(t, false));

        // Archived threads are per-channel, so only fetch when a parent is given.
        if (includeArchived && parentIdentifier) {
          const parent = await resolveThreadParent(guild, parentIdentifier);
          const archivedRes = await parent.threads.fetchArchived({ limit: 100 }).catch(() => null);
          if (archivedRes) {
            for (const t of archivedRes.threads.values()) threads.push(threadInfo(t, true));
          }
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              server: guild.name,
              parent: parentIdentifier ?? "(all active threads in server)",
              count: threads.length,
              threads,
              ...(includeArchived && !parentIdentifier
                ? { note: "includeArchived only applies when a parent channel is specified; showing active threads only." }
                : {}),
            }, null, 2),
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