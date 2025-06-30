import express from 'express';
import { promisify } from 'util';
import { exec } from 'child_process';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import { google } from 'googleapis';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DOWNLOADS_DIR = path.join('/tmp', 'downloads');
const ytDlpPath = 'yt-dlp'; // Pakai yt-dlp global atau dari nix

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  console.log(`[INFO] Folder download dibuat di ${DOWNLOADS_DIR}`);
}

const execAsync = promisify(exec);

// Inisialisasi Google OAuth2 Client
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Set kredensial dari .env
oauth2Client.setCredentials({
  access_token: process.env.GOOGLE_ACCESS_TOKEN,
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  scope: process.env.GOOGLE_SCOPE,
  token_type: process.env.GOOGLE_TOKEN_TYPE,
  expiry_date: parseInt(process.env.GOOGLE_EXPIRY_DATE),
});

// Refresh token jika expired
oauth2Client.on('tokens', (tokens) => {
  if (tokens.refresh_token) {
    console.log('[INFO] Refresh token diperbarui:', tokens.refresh_token);
    // Simpan refresh token baru ke file .env atau database jika perlu
  }
  console.log('[INFO] Access token diperbarui:', tokens.access_token);
});

// Inisialisasi YouTube API
const youtube = google.youtube({
  version: 'v3',
  auth: oauth2Client,
});

const sanitizeFilename = (filename) => {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') // karakter ilegal
    .replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{27BF}]/gu, '') // emoji & simbol
    .replace(/\s+/g, '_') // spasi jadi _
    .replace(/\.(mp3|mp4)$/i, '') // hapus ekstensi
    .substring(0, 150); // batasi panjang
};

const resolveRedirect = async (url) => {
  try {
    const response = await axios.head(url, { maxRedirects: 0, validateStatus: null });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      return response.headers.location;
    }
    return url;
  } catch {
    return url;
  }
};

const estimateFileSize = (bitrateKbps, durationSeconds) => {
  const sizeInBits = bitrateKbps * 1000 * durationSeconds;
  const sizeInBytes = sizeInBits / 8;
  const sizeInMB = sizeInBytes / (1024 * 1024);
  return sizeInMB.toFixed(2) + 'MB';
};

// ==========================================
// ✅ API: Get video info (include preview)
// ==========================================
app.post('/api/video-info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);
  const videoId = new URL(url).searchParams.get('v') || url.split('/').pop();

  try {
    // Cek autentikasi YouTube
    const videoResponse = await youtube.videos.list({
      part: 'snippet,contentDetails,statistics',
      id: videoId,
    });

    const videoData = videoResponse.data.items[0];
    if (!videoData) {
      return res.status(404).json({ error: 'Video tidak ditemukan' });
    }

    const command = `${ytDlpPath} --dump-json --no-warnings "${url}"`;
    console.log(`[INFO] Menjalankan command: ${command}`);

    const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 20 });
    const data = JSON.parse(stdout);

    console.log(`[INFO] Berhasil mendapatkan info: ${data.title}`);

    const formats = [];
    const videoQualities = new Set();
    const duration = data.duration || 0;

    data.formats
      .filter((f) => f.vcodec !== 'none' && f.height)
      .sort((a, b) => b.height - a.height)
      .forEach((f) => {
        const quality = `${f.height}p`;
        if (!videoQualities.has(quality)) {
          let size;
          if (f.filesize) {
            size = (f.filesize / (1024 * 1024)).toFixed(2) + 'MB';
          } else if (f.tbr && duration) {
            size = estimateFileSize(f.tbr, duration);
          } else {
            size = 'Unknown Size';
          }

          formats.push({
            quality,
            format: 'MP4',
            size,
            url: data.webpage_url || url,
            type: 'video',
          });
          videoQualities.add(quality);
        }
      });

    const bestAudio = data.formats
      .filter((f) => f.acodec !== 'none')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0) || (b.filesize || 0) - (a.filesize || 0))[0];

    if (bestAudio) {
      let audioSize;
      if (bestAudio.filesize) {
        audioSize = (bestAudio.filesize / (1024 * 1024)).toFixed(2) + 'MB';
      } else if (bestAudio.abr && duration) {
        audioSize = estimateFileSize(bestAudio.abr, duration);
      } else {
        audioSize = 'Unknown Size';
      }

      formats.push({
        quality: 'Best Audio',
        format: 'MP3',
        size: audioSize,
        url: data.webpage_url || url,
        type: 'audio',
      });
    }

    const previewFormat = data.formats.find(
      (f) => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' && f.filesize && f.filesize < 5 * 1024 * 1024
    );

    const previewUrl = previewFormat ? previewFormat.url : '';

    res.json({
      title: videoData.snippet.title || data.title || 'Unknown Title',
      thumbnail: videoData.snippet.thumbnails.high.url || data.thumbnail || '',
      previewUrl: previewUrl,
      duration: videoData.contentDetails.duration
        ? videoData.contentDetails.duration
        : duration
        ? new Date(duration * 1000).toISOString().substr(11, 8)
        : '00:00:00',
      formats,
    });
  } catch (err) {
    console.error(`[ERROR] Gagal mengambil info video: ${err.message}`);
    res.status(500).json({ error: 'Gagal mengambil info video', details: err.message });
  }
});

// ==========================================
// ✅ API: Download video/audio
// ==========================================
app.post('/api/download', async (req, res) => {
  const { url, filename, type, quality } = req.body;
  if (!url || !filename || !type || !quality) {
    return res.status(400).json({ error: 'Parameter url, filename, type, dan quality diperlukan' });
  }

  const sanitizedFilename = sanitizeFilename(filename);
  const outputFilePath = path.join(
    DOWNLOADS_DIR,
    `${sanitizedFilename}.${type === 'audio' ? 'mp3' : 'mp4'}`
  );

  const command = type === 'audio'
    ? `${ytDlpPath} --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" --extract-audio --audio-format mp3 -o "${outputFilePath}" "${url}"`
    : `${ytDlpPath} --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -f "bestvideo[height<=${parseInt(quality)}]+bestaudio/best" --merge-output-format mp4 -o "${outputFilePath}" "${url}"`;

  console.log(`[INFO] Menjalankan command download: ${command}`);

  try {
    await execAsync(command);

    const fileStream = fs.createReadStream(outputFilePath);
    const fileStats = fs.statSync(outputFilePath);

    res.setHeader('Content-Length', fileStats.size);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(sanitizedFilename)}.${type === 'audio' ? 'mp3' : 'mp4'}"`
    );

    console.log(`[INFO] Mulai mengirim file ${outputFilePath} ke client`);

    fileStream.pipe(res);

    fileStream.on('end', () => {
      console.log(`[INFO] File ${outputFilePath} berhasil dikirim dan dihapus.`);
      fs.unlink(outputFilePath, () => {});
    });

    fileStream.on('error', (err) => {
      console.error(`[ERROR] Gagal mengirim file: ${err.message}`);
      res.status(500).json({ error: 'Gagal mengirim file', details: err.message });
    });
  } catch (err) {
    console.error(`[ERROR] Gagal download: ${err.message}`);
    res.status(500).json({ error: 'Gagal download', details: err.message });
  }
});

// ==========================================
// ✅ API: OAuth2 Callback
// ==========================================
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Code tidak ditemukan' });
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    console.log('[INFO] Token berhasil diperoleh:', tokens);

    // Simpan tokens ke file .env atau database jika perlu
    res.redirect('/'); // Redirect ke halaman utama atau halaman sukses
  } catch (err) {
    console.error(`[ERROR] Gagal menangani OAuth2 callback: ${err.message}`);
    res.status(500).json({ error: 'Gagal autentikasi', details: err.message });
  }
});

// ==========================================
// ✅ API: Generate Auth URL
// ==========================================
app.get('/api/auth-url', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [process.env.GOOGLE_SCOPE],
  });
  res.json({ authUrl });
});

// ==========================================
// ✅ Jalankan server
// ==========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});