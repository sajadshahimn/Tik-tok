// ==========================================
//   TIKTOK DOWNLOADER BOT (سبک)
// ==========================================
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN تنظیم نشده');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// ---------- API تیک‌تاک (رایگان و بدون کلید) ----------
async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('پاسخ نامعتبر')); }
      });
    }).on('error', reject);
  });
}

async function getTikTokData(url) {
  // API رایگان tikwm.com - بدون کلید
  const api = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`;
  const data = await fetchJSON(api);

  if (!data || data.code !== 0 || !data.data) {
    throw new Error('اطلاعات ویدیو یافت نشد');
  }

  const d = data.data;

  // اول HD، بعد SD، بعد عکس‌ها
  if (d.hdplay) return { type: 'video', url: d.hdplay, title: d.title || '', author: d.author?.unique_id || '' };
  if (d.play) return { type: 'video', url: d.play, title: d.title || '', author: d.author?.unique_id || '' };
  if (d.images && d.images.length) return { type: 'images', urls: d.images, title: d.title || '', author: d.author?.unique_id || '' };

  throw new Error('فرمت پشتیبانی نمی‌شه');
}

// ---------- دانلود فایل ----------
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tiktok.com/' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    }).on('error', (e) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

// ---------- هندلر ----------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `🎵 <b>ربات دانلود تیک‌تاک</b>\n\n` +
    `فقط لینک تیک‌تاک رو بفرست 👇\n` +
    `مثال: <code>https://vt.tiktok.com/xxxxx</code>`,
    { parse_mode: 'HTML' }
  );
});

bot.on('message', async (msg) => {
  const cid = msg.chat.id;
  const text = msg.text;
  if (!text || text.startsWith('/')) return;

  // بررسی لینک تیک‌تاک
  const urlMatch = text.match(/https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/);
  if (!urlMatch) {
    return bot.sendMessage(cid, '🔗 یه لینک معتبر تیک‌تاک بفرست');
  }

  const url = urlMatch[0];
  const statusMsg = await bot.sendMessage(cid, '⏳ در حال دانلود...');

  const ts = Date.now();
  const videoPath = path.join(DOWNLOAD_DIR, `${ts}.mp4`);

  try {
    const data = await getTikTokData(url);

    if (data.type === 'video') {
      await downloadFile(data.url, videoPath);

      const stat = fs.statSync(videoPath);
      const sizeMB = stat.size / (1024 * 1024);

      // اگه بیشتر از 50MB بود، بفرست به‌عنوان داکیومنت
      const caption = `🎵 ${data.title.substring(0, 150) || 'تیک‌تاک'}\n${data.author ? '👤 @' + data.author : ''}`;

      if (sizeMB > 50) {
        await bot.sendDocument(cid, videoPath, { caption });
      } else {
        await bot.sendVideo(cid, videoPath, { caption, supports_streaming: true });
      }

      fs.unlinkSync(videoPath);
    } else if (data.type === 'images') {
      // آلبوم عکس
      const media = [];
      const files = [];

      for (let i = 0; i < data.urls.length && i < 10; i++) {
        const imgPath = path.join(DOWNLOAD_DIR, `${ts}_${i}.jpg`);
        await downloadFile(data.urls[i], imgPath);
        files.push(imgPath);
        media.push({ type: 'photo', media: imgPath });
      }

      // کپشن روی اولین عکس
      if (media.length) media[0].caption = data.title?.substring(0, 200) || '';

      await bot.sendMediaGroup(cid, media);

      files.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    }

    try { await bot.deleteMessage(cid, statusMsg.message_id); } catch {}
  } catch (err) {
    console.error('خطا:', err.message);
    try { await bot.deleteMessage(cid, statusMsg.message_id); } catch {}
    try { if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch {}

    let m = '❌ خطا در دانلود';
    if (err.message.includes('یافت نشد')) m = '❌ ویدیو پیدا نشد یا حذف شده';
    else if (err.message.includes('HTTP')) m = '❌ خطای شبکه';
    else if (err.message.includes('timeout')) m = '⏱ زمان تمام شد';

    bot.sendMessage(cid, m);
  }
});

// ---------- پاک‌سازی خودکار ----------
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOAD_DIR).forEach(f => {
      const p = path.join(DOWNLOAD_DIR, f);
      try {
        if (now - fs.statSync(p).mtimeMs > 10 * 60 * 1000) fs.unlinkSync(p);
      } catch {}
    });
  } catch {}
}, 5 * 60 * 1000);

console.log('🚀 TikTok Downloader Bot روشن شد');
