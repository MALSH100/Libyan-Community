// ─────────────────────────────────────────────────────────────────────────────
// clanfns.js — callable clan operations + the hub "My Clan" UI.
//   Mirrors the clan logic that lives in index.js (same db shape: db[guild][clanName]),
//   exposed as functions the hub can call for clickable clan management.
//   The original /clan-* slash commands keep working unchanged (index.js just adds
//   the Dinar charges for create / join / channel).
// ─────────────────────────────────────────────────────────────────────────────
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  UserSelectMenuBuilder, PermissionFlagsBits,
} = require('discord.js');

// prices (kept here so hub + index agree)
const CLAN_CREATE_COST  = 1000;
const CLAN_JOIN_COST    = 100;
const CLAN_CHANNEL_COST = 500;

// ── data helpers (operate on the shared db, same as index.js) ──
function clanEntries(db, gid) {
  const raw = db[gid] || {};
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('__')));
}
function userClan(db, gid, uid) {
  const raw = db[gid] || {};
  for (const [name, clan] of Object.entries(raw)) {
    if (name.startsWith('__')) continue;
    if (clan.leader === uid || (clan.officers || []).includes(uid) || (clan.members || []).includes(uid))
      return { name, clan };
  }
  return null;
}
function userRank(clan, uid) {
  if (!clan) return null;
  if (clan.leader === uid) return 'Leader';
  if ((clan.officers || []).includes(uid)) return 'Officer';
  if ((clan.members || []).includes(uid)) return 'Member';
  return null;
}
function rankLabel(clan, rank) {
  const n = (clan && clan.rankNames) || {};
  if (rank === 'Leader') return n.leader || 'Leader';
  if (rank === 'Officer') return n.officer || 'Officer';
  if (rank === 'Member') return n.member || 'Member';
  return rank;
}
function normaliseClan(clan) {
  if (!clan) return clan;
  clan.officers = clan.officers || [];
  clan.members = clan.members || [];
  clan.description = clan.description || 'No description set.';
  clan.motto = clan.motto || '';
  clan.xp = clan.xp || 0;
  clan.wins = clan.wins || 0;
  clan.losses = clan.losses || 0;
  clan.channelId = clan.channelId || null;
  clan.emoji = clan.emoji || '⚔️';
  clan.rankNames = clan.rankNames || { leader: 'Leader', officer: 'Officer', member: 'Member' };
  clan.leaderRoleId = clan.leaderRoleId || clan.roleId || null;
  clan.officerRoleId = clan.officerRoleId || null;
  clan.memberRoleId = clan.memberRoleId || clan.roleId || null;
  return clan;
}
const buildRoleName = (clanName, rankTitle) => `${clanName} — ${rankTitle}`;

async function assignRankRole(guild, clan, userId, newRank) {
  try {
    const member = await guild.members.fetch(userId);
    const leaderRole = guild.roles.cache.get(clan.leaderRoleId);
    const offRole = guild.roles.cache.get(clan.officerRoleId);
    const memRole = guild.roles.cache.get(clan.memberRoleId);
    for (const role of [leaderRole, offRole, memRole].filter(Boolean)) await member.roles.remove(role).catch(() => {});
    if (newRank === 'Leader' && leaderRole) await member.roles.add(leaderRole).catch(() => {});
    if (newRank === 'Officer' && offRole) await member.roles.add(offRole).catch(() => {});
    if (newRank === 'Member' && memRole) await member.roles.add(memRole).catch(() => {});
  } catch (e) { console.error(`assignRankRole failed for ${userId}:`, e.message); }
}
async function removeAllRankRoles(guild, clan, userId) {
  try {
    const m = await guild.members.fetch(userId);
    for (const id of [clan.leaderRoleId, clan.officerRoleId, clan.memberRoleId]) {
      const r = id && guild.roles.cache.get(id);
      if (r) await m.roles.remove(r).catch(() => {});
    }
  } catch {}
}

// ── operations (each returns {ok, msg} or {error}) ──
async function createClan(db, saveData, guild, uid, userTag, name, description) {
  name = (name || '').trim();
  description = (description || 'No description set.').trim();
  if (userClan(db, guild.id, uid)) return { error: 'You are already in a clan.' };
  if (name.length < 2 || name.length > 30) return { error: 'Clan name must be 2–30 characters.' };
  if (!db[guild.id]) db[guild.id] = {};
  if (db[guild.id][name] || name.startsWith('__')) return { error: `A clan named **${name}** already exists (or that name isn't allowed).` };
  const rn = { leader: 'Leader', officer: 'Officer', member: 'Member' };
  let leaderRole, officerRole, memberRole;
  try {
    leaderRole = await guild.roles.create({ name: buildRoleName(name, rn.leader), colors: { primaryColor: 0xFFD700 }, reason: `Clan created by ${userTag}` });
    officerRole = await guild.roles.create({ name: buildRoleName(name, rn.officer), colors: { primaryColor: 0x5865F2 }, reason: `Officer role for ${name}` });
    memberRole = await guild.roles.create({ name: buildRoleName(name, rn.member), colors: { primaryColor: 0x99AAB5 }, reason: `Member role for ${name}` });
  } catch (e) {
    if (leaderRole) await leaderRole.delete().catch(() => {});
    if (officerRole) await officerRole.delete().catch(() => {});
    return { error: 'Failed to create clan roles — check my permissions and role position.' };
  }
  try { const lm = await guild.members.fetch(uid); await lm.roles.add(leaderRole); } catch (e) { console.error('assign leader role:', e.message); }
  db[guild.id][name] = normaliseClan({
    leader: uid, officers: [], members: [], description, motto: '', emoji: '⚔️',
    leaderRoleId: leaderRole.id, officerRoleId: officerRole.id, memberRoleId: memberRole.id,
    roleId: memberRole.id, channelId: null, xp: 0, wins: 0, losses: 0,
    createdAt: new Date().toISOString(), rankNames: rn,
  });
  saveData(guild.id);
  return { ok: true, name, clan: db[guild.id][name] };
}

async function joinClan(db, saveData, guild, uid, clanName) {
  if (userClan(db, guild.id, uid)) return { error: 'You are already in a clan.' };
  const clan = db[guild.id] && db[guild.id][clanName];
  if (!clan) return { error: 'That clan no longer exists.' };
  normaliseClan(clan);
  await assignRankRole(guild, clan, uid, 'Member');
  clan.members.push(uid); saveData(guild.id);
  return { ok: true, name: clanName };
}

async function leaveClan(db, saveData, guild, uid) {
  const r = userClan(db, guild.id, uid);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader === uid) return { error: 'Leaders can\'t leave — transfer leadership or disband first.' };
  await removeAllRankRoles(guild, r.clan, uid);
  r.clan.officers = r.clan.officers.filter(id => id !== uid);
  r.clan.members = r.clan.members.filter(id => id !== uid);
  saveData(guild.id);
  return { ok: true, name: r.name };
}

async function kickMember(db, saveData, guild, actorId, targetId, targetName) {
  const r = userClan(db, guild.id, actorId);
  if (!r) return { error: 'You are not in a clan.' };
  const rank = userRank(r.clan, actorId);
  if (rank === 'Member') return { error: 'Only Leaders and Officers can kick.' };
  if (targetId === actorId) return { error: 'You can\'t kick yourself.' };
  if (r.clan.leader === targetId) return { error: 'You can\'t kick the Leader.' };
  const tRank = userRank(r.clan, targetId);
  if (!tRank) return { error: `**${targetName}** isn't in your clan.` };
  if (rank === 'Officer' && tRank === 'Officer') return { error: 'Officers can\'t kick other Officers.' };
  await removeAllRankRoles(guild, r.clan, targetId);
  r.clan.officers = r.clan.officers.filter(id => id !== targetId);
  r.clan.members = r.clan.members.filter(id => id !== targetId);
  saveData(guild.id);
  return { ok: true, name: r.name };
}

async function promoteMember(db, saveData, guild, actorId, targetId, targetName) {
  const r = userClan(db, guild.id, actorId);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== actorId) return { error: 'Only the Leader can promote.' };
  if (!r.clan.members.includes(targetId)) return { error: `**${targetName}** isn't a Member of your clan.` };
  await assignRankRole(guild, r.clan, targetId, 'Officer');
  r.clan.members = r.clan.members.filter(id => id !== targetId);
  r.clan.officers.push(targetId); saveData(guild.id);
  return { ok: true, label: rankLabel(r.clan, 'Officer'), name: r.name };
}

async function demoteMember(db, saveData, guild, actorId, targetId, targetName) {
  const r = userClan(db, guild.id, actorId);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== actorId) return { error: 'Only the Leader can demote.' };
  if (!r.clan.officers.includes(targetId)) return { error: `**${targetName}** isn't an Officer.` };
  await assignRankRole(guild, r.clan, targetId, 'Member');
  r.clan.officers = r.clan.officers.filter(id => id !== targetId);
  r.clan.members.push(targetId); saveData(guild.id);
  return { ok: true, label: rankLabel(r.clan, 'Member'), name: r.name };
}

async function transferLeader(db, saveData, guild, actorId, targetId, targetName) {
  const r = userClan(db, guild.id, actorId);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== actorId) return { error: 'Only the Leader can transfer leadership.' };
  if (targetId === actorId) return { error: 'You are already the Leader.' };
  if (!userRank(r.clan, targetId)) return { error: `**${targetName}** isn't in your clan.` };
  r.clan.officers = r.clan.officers.filter(id => id !== targetId);
  r.clan.members = r.clan.members.filter(id => id !== targetId);
  r.clan.members.push(actorId);
  r.clan.leader = targetId;
  await assignRankRole(guild, r.clan, targetId, 'Leader');
  await assignRankRole(guild, r.clan, actorId, 'Member');
  saveData(guild.id);
  return { ok: true, name: r.name };
}

async function disbandClan(db, saveData, guild, actorId) {
  const r = userClan(db, guild.id, actorId);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== actorId) return { error: 'Only the Leader can disband the clan.' };
  // delete roles
  for (const id of [r.clan.leaderRoleId, r.clan.officerRoleId, r.clan.memberRoleId]) {
    const role = id && guild.roles.cache.get(id);
    if (role) await role.delete('Clan disbanded').catch(() => {});
  }
  // delete channel
  if (r.clan.channelId) { const ch = guild.channels.cache.get(r.clan.channelId); if (ch) await ch.delete().catch(() => {}); }
  delete db[guild.id][r.name]; saveData(guild.id);
  return { ok: true, name: r.name };
}

function setText(db, saveData, gid, uid, field, value) {
  const r = userClan(db, gid, uid);
  if (!r) return { error: 'You are not in a clan.' };
  const rank = userRank(r.clan, uid);
  if (field === 'description' || field === 'motto') {
    if (rank === 'Member') return { error: 'Only Leaders and Officers can change that.' };
    r.clan[field] = value.slice(0, field === 'motto' ? 100 : 300);
    saveData(gid); return { ok: true };
  }
  return { error: 'Unknown field.' };
}

async function renameClan(db, saveData, guild, uid, newName, newEmoji) {
  const r = userClan(db, guild.id, uid);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== uid) return { error: 'Only the Leader can rename the clan.' };
  newName = (newName || '').trim();
  if (newName.length < 2 || newName.length > 30) return { error: 'Clan name must be 2–30 characters.' };
  if (newName !== r.name && (db[guild.id][newName] || newName.startsWith('__'))) return { error: `A clan named **${newName}** already exists.` };
  if (newEmoji) r.clan.emoji = newEmoji.trim();
  // update role names
  const rn = r.clan.rankNames || { leader: 'Leader', officer: 'Officer', member: 'Member' };
  const setName = async (id, title) => { const role = id && guild.roles.cache.get(id); if (role) await role.setName(buildRoleName(newName, title)).catch(() => {}); };
  await setName(r.clan.leaderRoleId, rn.leader);
  await setName(r.clan.officerRoleId, rn.officer);
  await setName(r.clan.memberRoleId, rn.member);
  if (newName !== r.name) { db[guild.id][newName] = r.clan; delete db[guild.id][r.name]; }
  saveData(guild.id);
  return { ok: true, name: newName };
}

async function createChannel(db, saveData, guild, client, uid) {
  const r = userClan(db, guild.id, uid);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== uid) return { error: 'Only the Leader can create the clan channel.' };
  if (r.clan.channelId) {
    const existing = guild.channels.cache.get(r.clan.channelId);
    if (existing) return { error: `Your clan already has a channel: ${existing}` };
    r.clan.channelId = null; saveData(guild.id);
  }
  const memberRole = guild.roles.cache.get(r.clan.memberRoleId || r.clan.roleId);
  const leaderRole = guild.roles.cache.get(r.clan.leaderRoleId);
  const offRole = guild.roles.cache.get(r.clan.officerRoleId);
  if (!memberRole) return { error: 'Clan roles not found.' };
  let channel;
  try {
    channel = await guild.channels.create({
      name: `${r.clan.emoji || '⚔️'}-${r.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 90)}`,
      topic: `Private channel for the ${r.name} clan.`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: memberRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ...(leaderRole && leaderRole.id !== memberRole.id ? [{ id: leaderRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : []),
        ...(offRole && offRole.id !== memberRole.id ? [{ id: offRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : []),
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    });
  } catch { return { error: 'Failed to create channel — check my Manage Channels permission.' }; }
  r.clan.channelId = channel.id; saveData(guild.id);
  await channel.send({ embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle(`${r.clan.emoji || '⚔️'} Welcome to ${r.name}'s channel!`).setDescription('Only clan members can see this!')] }).catch(() => {});
  return { ok: true, channel };
}

async function deleteChannel(db, saveData, guild, uid) {
  const r = userClan(db, guild.id, uid);
  if (!r) return { error: 'You are not in a clan.' };
  if (r.clan.leader !== uid) return { error: 'Only the Leader can delete the clan channel.' };
  if (!r.clan.channelId) return { error: 'Your clan doesn\'t have a private channel.' };
  const ch = guild.channels.cache.get(r.clan.channelId);
  if (ch) await ch.delete().catch(() => {});
  r.clan.channelId = null; saveData(guild.id);
  return { ok: true };
}

// ── join requests (one per user, 24h expiry). Stored at db[gid].__clanRequests[uid] ──
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
function requestStore(db, gid) {
  const g = db[gid] || (db[gid] = {});
  if (!g.__clanRequests) g.__clanRequests = {};
  return g.__clanRequests;
}
function pruneRequests(db, gid) {
  const store = requestStore(db, gid);
  const now = Date.now();
  let changed = false;
  for (const [uid, req] of Object.entries(store)) {
    if (!req || req.expiresAt <= now || !(db[gid] && db[gid][req.clanName])) { delete store[uid]; changed = true; }
  }
  return changed;
}
// create/replace a user's single pending request. No money taken here.
function requestJoin(db, saveData, gid, uid, clanName) {
  if (userClan(db, gid, uid)) return { error: 'You are already in a clan.' };
  const clan = db[gid] && db[gid][clanName];
  if (!clan) return { error: 'That clan no longer exists.' };
  const store = requestStore(db, gid);
  const existing = store[uid];
  store[uid] = { clanName, requestedAt: Date.now(), expiresAt: Date.now() + REQUEST_TTL_MS };
  saveData(gid);
  return { ok: true, replaced: existing ? existing.clanName : null, sameClan: existing && existing.clanName === clanName };
}
function cancelRequest(db, saveData, gid, uid) {
  const store = requestStore(db, gid);
  if (!store[uid]) return { error: 'You have no pending request.' };
  const clanName = store[uid].clanName; delete store[uid]; saveData(gid);
  return { ok: true, clanName };
}
function getRequest(db, gid, uid) {
  pruneRequests(db, gid);
  return requestStore(db, gid)[uid] || null;
}
// list pending requests for a given clan (after pruning stale ones)
function clanRequests(db, gid, clanName) {
  pruneRequests(db, gid);
  const store = requestStore(db, gid);
  return Object.entries(store).filter(([, r]) => r.clanName === clanName).map(([uid, r]) => ({ uid, ...r }));
}
// accept a request: verify actor is leader/officer, requester still has room + funds, then add & charge.
async function acceptRequest(db, saveData, guild, actorId, requesterId, joinCost, getDinar, spendDinar) {
  const mine = userClan(db, guild.id, actorId);
  if (!mine) return { error: 'You are not in a clan.' };
  if (userRank(mine.clan, actorId) === 'Member') return { error: 'Only Leaders and Officers can accept requests.' };
  const store = requestStore(db, guild.id);
  const req = store[requesterId];
  if (!req || req.clanName !== mine.name) return { error: 'That request no longer exists.' };
  if (req.expiresAt <= Date.now()) { delete store[requesterId]; saveData(guild.id); return { error: 'That request has expired.' }; }
  if (userClan(db, guild.id, requesterId)) { delete store[requesterId]; saveData(guild.id); return { error: 'That user is already in a clan.' }; }
  if (getDinar(db, guild.id, requesterId) < joinCost) {
    return { error: `That member no longer has the **${joinCost.toLocaleString()} Dinar** join fee — request kept pending.`, insufficient: true };
  }
  normaliseClan(mine.clan);
  await assignRankRole(guild, mine.clan, requesterId, 'Member');
  mine.clan.members.push(requesterId);
  spendDinar(db, guild.id, requesterId, joinCost, saveData);   // charged only on accept
  delete store[requesterId];
  saveData(guild.id);
  return { ok: true, clanName: mine.name };
}
function declineRequest(db, saveData, guild, actorId, requesterId) {
  const mine = userClan(db, guild.id, actorId);
  if (!mine) return { error: 'You are not in a clan.' };
  if (userRank(mine.clan, actorId) === 'Member') return { error: 'Only Leaders and Officers can decline requests.' };
  const store = requestStore(db, guild.id);
  const req = store[requesterId];
  if (!req || req.clanName !== mine.name) return { error: 'That request no longer exists.' };
  delete store[requesterId]; saveData(guild.id);
  return { ok: true, clanName: mine.name };   // no money taken — nothing to refund
}

module.exports = {
  CLAN_CREATE_COST, CLAN_JOIN_COST, CLAN_CHANNEL_COST,
  clanEntries, userClan, userRank, rankLabel, normaliseClan,
  createClan, joinClan, leaveClan, kickMember, promoteMember, demoteMember,
  transferLeader, disbandClan, setText, renameClan, createChannel, deleteChannel,
  requestJoin, cancelRequest, getRequest, clanRequests, acceptRequest, declineRequest, pruneRequests, REQUEST_TTL_MS,
};
