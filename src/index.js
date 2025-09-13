require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, InteractionType } = require('discord.js');
const { DateTime } = require('luxon');
const { loadJson, saveJson } = require('./utils');

const TOKEN = process.env.DISCORD_TOKEN;
const APP_ID = process.env.APP_ID || '';
if (!TOKEN) {
  console.error('Set DISCORD_TOKEN in env');
  process.exit(1);
}

// Config
const DATA_DIR = path.join(__dirname, '..', 'data');
const ROLES_FILE = path.join(DATA_DIR, 'allowed_roles.json');
const FLIGHTS_FILE = path.join(DATA_DIR, 'flights.json');
const VATSIM_FILE = path.join(DATA_DIR, 'vatsim_state.json');

const CHARTS_ROOT = path.join(__dirname, '..', 'charts');

const MEMBER_ROLE_NAME = 'Member';
const ADMIN_ROLES = ['DEV', 'Admin'];
const BAN_ROLES = ['band'];
const VATSIM_CHANNEL_NAME = '🌐vatsim-online';
const VATSIM_AIRPORT_PREFIXES = ['VV','VL','VD'];

const VN_ZONE = 'Asia/Ho_Chi_Minh';

let ALLOWED_ROLES = loadJson(ROLES_FILE, []);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel]
});

// create axios instance
const httpClient = axios.create({ timeout: 15000 });

// Helpers
function memberHasAnyRole(member, roleNames = []) {
  if (!member) return false;
  const lower = roleNames.map(r => r.toLowerCase());
  return member.roles.cache.some(r => lower.includes(r.name.toLowerCase()));
}

function isAdmin(interaction) {
  const member = interaction.member;
  if (!member) return false;
  const guildPerm = member.permissions?.has(PermissionFlagsBits.Administrator);
  return Boolean(guildPerm || memberHasAnyRole(member, ADMIN_ROLES));
}

function safeSaveRoles() {
  ALLOWED_ROLES = ALLOWED_ROLES || [];
  saveJson(ROLES_FILE, ALLOWED_ROLES);
}

// Interaction handling
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand && interaction.commandName) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === 'group_flight_modal') {
        return handleGroupFlightModal(interaction);
      }
    }

    if (interaction.isStringSelectMenu()) {
      // role select, chart select, etc. customId patterns:
      // role_select:{userId}
      // chart_select:{icao}
      // announce_channel_select
      const custom = interaction.customId;
      if (custom.startsWith('role_select:')) {
        const targetId = custom.split(':')[1];
        return handleRoleSelect(interaction, targetId);
      } else if (custom.startsWith('chart_select:')) {
        return handleChartSelect(interaction);
      } else if (custom === 'announce_channel_select') {
        return handleAnnounceChannelSelect(interaction);
      }
    }

    if (interaction.isButton()) {
      // join:{messageId}, leave:{messageId}, cancel:{messageId}
      const id = interaction.customId;
      if (id.startsWith('join:')) return handleJoinButton(interaction);
      if (id.startsWith('leave:')) return handleLeaveButton(interaction);
      if (id.startsWith('cancel:')) return handleCancelButton(interaction);
      if (id.startsWith('announce_send:')) return handleAnnounceSend(interaction);
    }
  } catch (err) {
    console.error('interactionCreate error', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'Đã có lỗi nội bộ.', ephemeral: true }); } catch(e){}
  }
});

// Command router
async function handleCommand(interaction) {
  const cmd = interaction.commandName;
  if (cmd === 'setup_role') {
    if (!isAdmin(interaction)) return interaction.reply({ content: ':x: Bạn không có quyền.', ephemeral: true });
    const roles = interaction.options.getString('roles', true);
    ALLOWED_ROLES = roles.split(',').map(x => x.trim()).filter(Boolean);
    safeSaveRoles();
    return interaction.reply({ content: `✅ Đã lưu: ${ALLOWED_ROLES.join(', ')}`, ephemeral: true });
  }

  if (cmd === 'give_role') {
    // show select menu if allowed roles exists and member checks pass
    if (!ALLOWED_ROLES || ALLOWED_ROLES.length === 0) return interaction.reply({ content: ':x: Chưa có role nào được cấu hình.', ephemeral: true });
    const member = interaction.member;
    if (memberHasAnyRole(member, BAN_ROLES)) return interaction.reply({ content: ':x: Bạn đã bị cấm xin role.', ephemeral: true });
    const isPriv = isAdmin(interaction);
    const hasMember = memberHasAnyRole(member, [MEMBER_ROLE_NAME]);
    if (!hasMember && !isPriv) {
      if (ALLOWED_ROLES.includes(MEMBER_ROLE_NAME)) {
        const menu = new StringSelectMenuBuilder()
          .setCustomId(`role_select:${interaction.user.id}`)
          .setPlaceholder('Chọn role bạn muốn nhận...')
          .addOptions(ALLOWED_ROLES.filter(r=>r===MEMBER_ROLE_NAME).map(r=>({label:r,value:r})));
        await interaction.reply({ content: 'Bạn cần role Member trước. Chọn ở dưới:', components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      } else {
        await interaction.reply({ content: ':x: Bạn cần role Member trước và role không được mở để xin.', ephemeral: true });
      }
      return;
    }
    const valid = ALLOWED_ROLES.filter(r => interaction.guild.roles.cache.some(rr => rr.name === r));
    if (!valid.length) return interaction.reply({ content: ':x: Không có role hợp lệ trên server.', ephemeral: true });
    const menu2 = new StringSelectMenuBuilder()
      .setCustomId(`role_select:${interaction.user.id}`)
      .setPlaceholder('Chọn role...')
      .addOptions(valid.map(r => ({ label: r, value: r })));
    await interaction.reply({ content: 'Chọn role bạn muốn:', components: [new ActionRowBuilder().addComponents(menu2)], ephemeral: true });
    return;
  }

  if (cmd === 'send_announcement') {
    if (!isAdmin(interaction)) return interaction.reply({ content: ':x: Bạn không có quyền.', ephemeral: true });
    const message = interaction.options.getString('message', true);
    // reply ephemeral with a channel select (use channel select menu)
    const channelSelect = new ChannelSelectMenuBuilder()
      .setCustomId('announce_channel_select')
      .setPlaceholder('Chọn kênh để gửi thông báo');
    await interaction.reply({ content: 'Chọn kênh để gửi thông báo (ephemeral):', components: [new ActionRowBuilder().addComponents(channelSelect)], ephemeral: true });
    // store the message to be sent in a temp map on the user — simplest: write to in-memory Map keyed by userId
    tempAnnouncementStore[interaction.user.id] = message;
    return;
  }

  if (cmd === 'metar') {
    await interaction.deferReply();
    const icao = interaction.options.getString('icao', true).toUpperCase();
    try {
      const res = await httpClient.get(`https://metar-taf.com/json?icao=${icao}`);
      const data = res.data;
      if (!data || !data.raw) return interaction.followUp({ content: `:x: Không tìm thấy METAR cho ${icao}` });
      const embed = new EmbedBuilder()
        .setTitle(`☁️ METAR ${icao}`)
        .setDescription(`\`\`\`${data.raw}\`\`\``)
        .setColor(0x5865f2);
      if (data.timestamp && data.timestamp.dt) {
        embed.setTimestamp(new Date(data.timestamp.dt));
      }
      embed.addFields(
        { name: 'Temperature', value: `${data.temperature?.value ?? 'N/A'}°C`, inline: true },
        { name: 'Dew Point', value: `${data.dewpoint?.value ?? 'N/A'}°C`, inline: true },
        { name: 'Wind', value: `${data.wind?.repr ?? 'N/A'}`, inline: true },
        { name: 'Visibility', value: `${data.visibility?.repr ?? 'N/A'}`, inline: true },
        { name: 'Pressure', value: `${data.altimeter?.repr ?? 'N/A'}`, inline: true },
        { name: 'Clouds', value: `${(data.clouds && data.clouds[0]?.repr) ?? 'N/A'}`, inline: true }
      );
      return interaction.followUp({ embeds: [embed] });
    } catch (e) {
      console.error('metar error', e);
      return interaction.followUp({ content: `:x: Lỗi khi lấy METAR: ${e.message}` });
    }
  }

  if (cmd === 'chart') {
    await interaction.deferReply();
    const icao = interaction.options.getString('icao', true).toUpperCase();
    const folder = path.join(CHARTS_ROOT, icao);
    if (!fs.existsSync(folder)) return interaction.followUp({ content: `:x: Không tìm thấy folder charts/${icao}` });
    const pdfs = fs.readdirSync(folder).filter(f => f.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) return interaction.followUp({ content: `:x: Không có file PDF trong charts/${icao}` });
    if (pdfs.length === 1) {
      const filePath = path.join(folder, pdfs[0]);
      const attachment = new AttachmentBuilder(filePath);
      return interaction.followUp({ content: `📑 Chart ${pdfs[0]}`, files: [attachment] });
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`chart_select:${icao}`)
      .setPlaceholder('Chọn chart')
      .addOptions(pdfs.slice(0,25).map(p => ({ label: p, value: p })));
    return interaction.followUp({ content: `Chọn chart cho ${icao}`, components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  }

  if (cmd === 'group_flight') {
    // show modal
    const modal = new ModalBuilder()
      .setCustomId('group_flight_modal')
      .setTitle('Tạo Sự Kiện Bay Nhóm');

    const titleInput = new TextInputBuilder().setCustomId('gf_title').setLabel('Tiêu đề (<=45)').setStyle(TextInputStyle.Short).setRequired(true);
    const routeInput = new TextInputBuilder().setCustomId('gf_route').setLabel('Lộ trình').setStyle(TextInputStyle.Short).setRequired(true);
    const startInput = new TextInputBuilder().setCustomId('gf_start').setLabel('Bắt đầu (UTC YYYY-MM-DD HH:MM)').setStyle(TextInputStyle.Short).setRequired(true);
    const endInput = new TextInputBuilder().setCustomId('gf_end').setLabel('Kết thúc (UTC YYYY-MM-DD HH:MM)').setStyle(TextInputStyle.Short).setRequired(true);

    // Add inputs to modal (max 5 rows)
    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(routeInput),
      new ActionRowBuilder().addComponents(startInput),
      new ActionRowBuilder().addComponents(endInput)
    );

    return interaction.showModal(modal);
  }

  if (cmd === 'vatsim_set_channel') {
    if (!isAdmin(interaction)) return interaction.reply({ content: ':x: Bạn không có quyền.', ephemeral: true });
    const ch = interaction.options.getChannel('channel', true);
    const state = loadJson(VATSIM_FILE, {});
    state[interaction.guild.id] = { channelId: ch.id }; // remove messageId so next run will post new
    saveJson(VATSIM_FILE, state);
    return interaction.reply({ content: `✅ Đã lưu kênh ${ch.toString()} cho VATSIM updates`, ephemeral: true });
  }

  if (cmd === 'vatsim_vtest') {
    if (!isAdmin(interaction)) return interaction.reply({ content: ':x: Bạn không có quyền.', ephemeral: true });
    const state = loadJson(VATSIM_FILE, {});
    const g = state[interaction.guild.id];
    if (!g || !g.channelId) return interaction.reply({ content: ':x: Chưa set kênh. Dùng /vatsim_set_channel', ephemeral: true });
    const channel = interaction.guild.channels.cache.get(g.channelId);
    if (!channel) return interaction.reply({ content: ':x: Kênh lưu không tồn tại.', ephemeral: true });
    const embed = new EmbedBuilder().setTitle('VATSIM Test').setDescription('Đây là test từ /vatsim_vtest').setColor(0x009fe3);
    const msg = await channel.send({ embeds: [embed] });
    g.messageId = msg.id;
    state[interaction.guild.id] = g;
    saveJson(VATSIM_FILE, state);
    return interaction.reply({ content: `✅ Đã gửi test tới ${channel}`, ephemeral: true });
  }
}

// Temporary in-memory store for announcements
const tempAnnouncementStore = {};

// Handle channel select for announcement
async function handleAnnounceChannelSelect(interaction) {
  try {
    const channel = interaction.values[0]; // returns channel id
    const ch = interaction.guild.channels.cache.get(channel);
    const message = tempAnnouncementStore[interaction.user.id];
    if (!message) {
      await interaction.reply({ content: ':x: Không tìm thấy nội dung thông báo (hết hạn).', ephemeral: true });
      return;
    }
    const embed = new EmbedBuilder()
      .setDescription(message)
      .setColor(0x3498db)
      .setAuthor({ name: `Thông báo từ ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
      .setTimestamp(new Date());
    await ch.send({ embeds: [embed] });
    delete tempAnnouncementStore[interaction.user.id];
    await interaction.reply({ content: `✅ Đã gửi thông báo tới ${ch}`, ephemeral: true });
  } catch (e) {
    console.error('announce channel select error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi gửi thông báo.', ephemeral: true }); } catch(e){}
  }
}

// Role select handler
async function handleRoleSelect(interaction, targetUserId) {
  try {
    // Check user
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: ':x: Bạn không được phép dùng menu này.', ephemeral: true });
    }
    const roleName = interaction.values[0];
    const role = interaction.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return interaction.reply({ content: ':x: Role không tồn tại.', ephemeral: true });
    const me = interaction.guild.members.me;
    if (role.position >= me.roles.highest.position) return interaction.reply({ content: ':x: Bot không đủ quyền gán role này.', ephemeral: true });
    const member = interaction.member;
    if (member.roles.cache.has(role.id)) return interaction.reply({ content: ':warning: Bạn đã có role này.', ephemeral: true });
    await member.roles.add(role);
    return interaction.reply({ content: `✅ Đã gán role **${roleName}**`, ephemeral: true });
  } catch (e) {
    console.error('role select error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi xử lý xin role.', ephemeral: true }); } catch(e){}
  }
}

// Chart select
async function handleChartSelect(interaction) {
  try {
    const icao = interaction.customId.split(':')[1];
    const filename = interaction.values[0];
    const filepath = path.join(CHARTS_ROOT, icao, filename);
    if (!fs.existsSync(filepath)) return interaction.reply({ content: ':x: File không tồn tại.', ephemeral: true });
    const attach = new AttachmentBuilder(filepath);
    await interaction.reply({ content: `📑 ${filename}`, files: [attach], ephemeral: true });
  } catch (e) {
    console.error('chart select error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi gửi chart.', ephemeral: true }); } catch(e){}
  }
}

// Group flight modal submit
async function handleGroupFlightModal(interaction) {
  try {
    const title = interaction.fields.getTextInputValue('gf_title').slice(0,45);
    const route = interaction.fields.getTextInputValue('gf_route');
    const startRaw = interaction.fields.getTextInputValue('gf_start');
    const endRaw = interaction.fields.getTextInputValue('gf_end');

    // parse as UTC
    const start = DateTime.fromFormat(startRaw, 'yyyy-LL-dd HH:mm', { zone: 'utc' });
    const end = DateTime.fromFormat(endRaw, 'yyyy-LL-dd HH:mm', { zone: 'utc' });
    if (!start.isValid || !end.isValid) {
      return interaction.reply({ content: ':x: Định dạng thời gian không hợp lệ. Dùng YYYY-MM-DD HH:MM (UTC).', ephemeral: true });
    }
    if (end <= start) return interaction.reply({ content: ':x: Thời gian kết thúc phải sau thời gian bắt đầu.', ephemeral: true });

    const embed = new EmbedBuilder()
      .setTitle(`✈️ Sự Kiện Bay: ${title}`)
      .setColor(0x1abc9c)
      .setAuthor({ name: `Tổ chức: ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
      .addFields(
        { name: '📍 Lộ trình', value: `\`${route}\``, inline: false },
        { name: '⏰ Bắt đầu (UTC)', value: `<t:${Math.floor(start.toSeconds())}:F>`, inline: true },
        { name: '🏁 Kết thúc (UTC)', value: `<t:${Math.floor(end.toSeconds())}:F>`, inline: true },
        { name: '👥 Thành viên tham gia (0)', value: 'Chưa có ai tham gia.', inline: false }
      ).setFooter({ text: 'Nhấn Tham gia / Huỷ tham gia' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join:temporary`).setLabel('Tham gia').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`leave:temporary`).setLabel('Huỷ tham gia').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel:temporary`).setLabel('Hủy sự kiện').setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
    const msg = await interaction.fetchReply();

    // update DB: store under msg.id
    const flights = loadJson(FLIGHTS_FILE, {});
    flights[msg.id] = {
      title,
      creatorId: interaction.user.id,
      startTime: start.toISO(),
      endTime: end.toISO(),
      participants: [],
      reminded15: false,
      reminded5: false
    };
    saveJson(FLIGHTS_FILE, flights);

    // update buttons with message id in customId
    const newRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join:${msg.id}`).setLabel('Tham gia').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`leave:${msg.id}`).setLabel('Huỷ tham gia').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`cancel:${msg.id}`).setLabel('Hủy sự kiện').setStyle(ButtonStyle.Secondary)
    );
    await msg.edit({ components: [newRow] });
    return;
  } catch (e) {
    console.error('group modal submit error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi tạo sự kiện.', ephemeral: true }); } catch(e){}
  }
}

// Buttons: join / leave / cancel
async function handleJoinButton(interaction) {
  try {
    const messageId = interaction.customId.split(':')[1];
    const flights = loadJson(FLIGHTS_FILE, {});
    const evt = flights[messageId];
    if (!evt) return interaction.reply({ content: ':x: Sự kiện không tồn tại.', ephemeral: true });
    const uid = interaction.user.id;
    if (evt.participants.includes(uid)) return interaction.reply({ content: ':warning: Bạn đã tham gia.', ephemeral: true });
    evt.participants.push(uid);
    saveJson(FLIGHTS_FILE, flights);

    // update embed
    const msg = await interaction.message.fetch();
    const embed = msg.embeds[0].toJSON();
    const participants = evt.participants.map(id => `<@${id}>`).join('\n');
    // find field index
    const fields = embed.fields || [];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].name.includes('Thành viên tham gia')) {
        fields[i] = { name: `👥 Thành viên tham gia (${evt.participants.length})`, value: participants || 'Chưa có ai tham gia.', inline: false };
        break;
      }
    }
    const newEmbed = EmbedBuilder.from(embed).setFields(fields);
    await msg.edit({ embeds: [newEmbed] });
    return interaction.reply({ content: '✅ Bạn đã tham gia.', ephemeral: true });
  } catch (e) {
    console.error('join button error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi tham gia.', ephemeral: true }); } catch(e){}
  }
}

async function handleLeaveButton(interaction) {
  try {
    const messageId = interaction.customId.split(':')[1];
    const flights = loadJson(FLIGHTS_FILE, {});
    const evt = flights[messageId];
    if (!evt) return interaction.reply({ content: ':x: Sự kiện không tồn tại.', ephemeral: true });
    const uid = interaction.user.id;
    if (!evt.participants.includes(uid)) return interaction.reply({ content: ':warning: Bạn chưa tham gia.', ephemeral: true });
    evt.participants = evt.participants.filter(x=>x!==uid);
    saveJson(FLIGHTS_FILE, flights);

    // update embed
    const msg = await interaction.message.fetch();
    const embed = msg.embeds[0].toJSON();
    const participants = evt.participants.map(id => `<@${id}>`).join('\n');
    const fields = embed.fields || [];
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].name.includes('Thành viên tham gia')) {
        fields[i] = { name: `👥 Thành viên tham gia (${evt.participants.length})`, value: participants || 'Chưa có ai tham gia.', inline: false };
        break;
      }
    }
    const newEmbed = EmbedBuilder.from(embed).setFields(fields);
    await msg.edit({ embeds: [newEmbed] });
    return interaction.reply({ content: '✅ Bạn đã rời sự kiện.', ephemeral: true });
  } catch (e) {
    console.error('leave button error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi huỷ tham gia.', ephemeral: true }); } catch(e){}
  }
}

async function handleCancelButton(interaction) {
  try {
    const messageId = interaction.customId.split(':')[1];
    const flights = loadJson(FLIGHTS_FILE, {});
    const evt = flights[messageId];
    if (!evt) return interaction.reply({ content: ':x: Sự kiện không tồn tại.', ephemeral: true });
    if (interaction.user.id !== evt.creatorId && !isAdmin(interaction)) return interaction.reply({ content: ':x: Bạn không có quyền hủy sự kiện.', ephemeral: true });

    // notify participants
    for (const uid of evt.participants) {
      try {
        const user = await client.users.fetch(uid);
        await user.send(`Sự kiện **${evt.title}** đã bị hủy bởi ${interaction.user.username}.`);
      } catch (e) {
        // ignore DM failures
      }
    }

    // delete message
    try { await interaction.message.delete(); } catch(e) {}

    delete flights[messageId];
    saveJson(FLIGHTS_FILE, flights);
    return interaction.reply({ content: '✅ Sự kiện đã được hủy.', ephemeral: true });
  } catch (e) {
    console.error('cancel button error', e);
    try { await interaction.reply({ content: ':x: Lỗi khi hủy sự kiện.', ephemeral: true }); } catch(e){}
  }
}

// VATSIM scheduler
async function vatsimTick() {
  try {
    const state = loadJson(VATSIM_FILE, {});
    let data;
    try {
      const res = await httpClient.get('https://data.vatsim.net/v3/vatsim-data.json');
      data = res.data;
    } catch (e) {
      console.error('vatsim fetch error', e.message);
      return;
    }

    const controllers = data.controllers || [];
    const pilots = data.pilots || [];

    const atcs = controllers.filter(c => VATSIM_AIRPORT_PREFIXES.some(p => c.callsign?.toUpperCase().startsWith(p)));
    const pilotsFiltered = pilots.filter(p => {
      const fp = p.flight_plan;
      if (!fp) return false;
      const dep = (fp.departure || '').toUpperCase();
      const arr = (fp.arrival || '').toUpperCase();
      return VATSIM_AIRPORT_PREFIXES.some(pref => dep.startsWith(pref) || arr.startsWith(pref));
    });

    const embed = new EmbedBuilder()
      .setTitle(`🌐 VATSIM Online - ${DateTime.utc().toFormat('HH:mm ZZZ dd/LL/yyyy')}`)
      .setColor(0x009fe3)

    const atcText = atcs.sort((a,b)=>(a.callsign||'').localeCompare(b.callsign||'')).map(c => `**${c.callsign}** (${c.name}) - \`${c.frequency}\``).join('\n') || 'Không có ATC online.';
    const pilotText = pilotsFiltered.sort((a,b)=>(a.callsign||'').localeCompare(b.callsign||'')).map(p => {
      const fp = p.flight_plan || {};
      return `**${p.callsign}** (${p.name}) - \`${fp.departure||''}\` ➔ \`${fp.arrival||''}\``;
    }).join('\n') || 'Không có chuyến bay.';

    embed.addFields(
      { name: `📡 ATC Online (${atcs.length})`, value: atcText, inline: false },
      { name: `✈️ Pilots (${pilotsFiltered.length})`, value: pilotText, inline: false }
    );

    // For each guild, post/update in saved channel, fallback by name
    for (const guild of client.guilds.cache.values()) {
      try {
        const gState = state[guild.id] || {};
        let ch = null;
        if (gState.channelId) ch = guild.channels.cache.get(gState.channelId);
        if (!ch) ch = guild.channels.cache.find(c => c.isTextBased() && c.name === VATSIM_CHANNEL_NAME);
        if (!ch) continue;
        // permission
        const me = guild.members.me;
        const perms = ch.permissionsFor(me);
        if (!perms.has(['ViewChannel','SendMessages','EmbedLinks'])) continue;
        if (gState.messageId) {
          try {
            const msg = await ch.messages.fetch(gState.messageId);
            await msg.edit({ embeds: [embed] });
          } catch (e) {
            // send new if fetch fails
            const msg = await ch.send({ embeds: [embed] });
            gState.messageId = msg.id;
            state[guild.id] = gState;
          }
        } else {
          const msg = await ch.send({ embeds: [embed] });
          gState.messageId = msg.id;
          state[guild.id] = gState;
        }
      } catch (e) {
        console.error('vatsim per-guild error', e);
      }
    }

    saveJson(VATSIM_FILE, state);
  } catch (e) {
    console.error('vatsimTick error', e);
  }
}

// Reminders scheduler (1 minute)
async function reminderTick() {
  try {
    const flights = loadJson(FLIGHTS_FILE, {});
    const nowUtc = DateTime.utc();
    for (const [mid, evt] of Object.entries(flights)) {
      try {
        let start = DateTime.fromISO(evt.startTime, { zone: 'utc' });
        if (!start.isValid) continue;
        // cleanup if older than 1 day after start
        if (nowUtc > start.plus({ days: 1 })) {
          delete flights[mid];
          continue;
        }
        const delta = start.diff(nowUtc, ['minutes','seconds']).toObject();
        const mins = delta.minutes || 0;
        // 15-minute reminder: >5 and <=15
        if (mins > 5 && mins <= 15 && !evt.reminded15) {
          for (const uid of evt.participants || []) {
            try {
              const u = await client.users.fetch(uid);
              const vnLocal = start.setZone(VN_ZONE).toFormat('yyyy-LL-dd HH:mm');
              await u.send(`👋 Reminder (15 phút): Sự kiện **${evt.title}** sẽ bắt đầu lúc ${vnLocal} (GMT+7).`);
            } catch (e) {}
          }
          evt.reminded15 = true;
        }
        // 5-minute reminder
        if (mins > 0 && mins <= 5 && !evt.reminded5) {
          for (const uid of evt.participants || []) {
            try {
              const u = await client.users.fetch(uid);
              const vnLocal = start.setZone(VN_ZONE).toFormat('yyyy-LL-dd HH:mm');
              await u.send(`⏰ Reminder (5 phút): Sự kiện **${evt.title}** sẽ bắt đầu lúc ${vnLocal} (GMT+7).`);
            } catch (e) {}
          }
          evt.reminded5 = true;
        }
      } catch (e) { console.error('reminder per-event error', e); }
    }
    saveJson(FLIGHTS_FILE, flights);
  } catch (e) { console.error('reminderTick error', e); }
}

// startup
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // start schedulers
  setInterval(vatsimTick, 10 * 60 * 1000); // 10 min
  // run immediately
  vatsimTick().catch(e=>console.error(e));
  setInterval(reminderTick, 60 * 1000); // 1 min
  reminderTick().catch(e=>console.error(e));
});

// Minimal HTTP server so Render sees an open port (works for Web Service type)
const httpServer = require('http');
const port = process.env.PORT || 3000;

const server = httpServer.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running\n');
});

server.listen(port, () => {
  console.log(`HTTP server listening on port ${port}`);
});

client.login(TOKEN);
