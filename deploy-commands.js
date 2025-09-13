// deploy-commands.js
const { REST, Routes } = require('discord.js');
require('dotenv').config();

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Missing DISCORD_TOKEN in env');
  process.exit(1);
}

// Replace with your APPLICATION ID (bot client id) and optionally GUILD_ID for guild-scoped registration
const APP_ID = process.env.APP_ID;      // set in env
const GUILD_ID = process.env.GUILD_ID;  // optional for testing; remove for global deploy

const commands = [
  {
    name: 'setup_role',
    description: '[Admin] Thiết lập các role được phép xin',
    options: [{
      name: 'roles',
      type: 3,
      description: 'Danh sách role, ngăn cách bằng dấu phẩy',
      required: true
    }]
  },
  { name: 'give_role', description: 'Xin một role đã được cấu hình' },
  { name: 'send_announcement', description: '[Admin] Gửi thông báo', options: [{name:'message', type:3, description:'Nội dung', required:true}]},
  { name: 'metar', description: 'Lấy METAR (metar-taf.com)', options:[{name:'icao', type:3, description:'VD: VVTS', required:true}]},
  { name: 'chart', description: 'Gửi chart PDF từ charts/<ICAO>', options:[{name:'icao', type:3, description:'VD: VVTS', required:true}]},
  { name: 'group_flight', description: 'Tạo sự kiện bay nhóm' },
  { name: 'vatsim_set_channel', description: '[Admin] Set kênh VATSIM', options:[{name:'channel', type:7, description:'Kênh text', required:true}]},
  { name: 'vatsim_vtest', description: '[Admin] Gửi test VATSIM embed' }
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    if (!APP_ID) throw new Error('Set APP_ID in env');
    console.log('Started refreshing application (/) commands.');

    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), { body: commands });
      console.log('Registered commands to guild', GUILD_ID);
    } else {
      await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
      console.log('Registered global commands');
    }

    console.log('Done.');
  } catch (error) {
    console.error(error);
  }
})();
