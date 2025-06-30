
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

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DOWNLOADS_DIR = path.join('/tmp', 'downloads');
const ytDlpPath = path.join(__dirname, 'yt-dlp');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// === Google API Setup ===
const youtube = google.youtube({
  version: 'v3',
  auth: process.env.GOOGLE_API_KEY,
});

// === OAuth2 Setup ===
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Set token langsung dari env
oauth2Client.setCredentials({
  access_token: process.env.GOOGLE_ACCESS_TOKEN,
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  scope: process.env.GOOGLE_SCOPE,
  token_type: process.env.GOOGLE_TOKEN_TYPE,
  expiry_date: parseInt(process.env.GOOGLE_EXPIRY_DATE),
});

// URL Auth (jika mau refresh token)
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/youtube.readonly'],
});
console.log('Buka URL ini untuk autentikasi OAuth (jika diperlukan):', authUrl);

const execAsync = promisify(exec);

const sanitizeFilename = (filename) => {
  return filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.(mp3|mp4)$/, '');
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

// === API: OAuth Callback ===
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Code diperlukan untuk autentikasi.');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    res.send(`Autentikasi berhasil. Token:\n\n${JSON.stringify(tokens, null, 2)}`);
  } catch (err) {
    res.status(500).send('Gagal autentikasi: ' + err.message);
  }
});

// === API: Video Info ===
app.post('/api/video-info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);
  let videoId;
  try {
    const urlObj = new URL(url);
    videoId = urlObj.searchParams.get('v') || url.split('/').pop();
  } catch {
    return res.status(400).json({ error: 'URL tidak valid' });
  }

  try {
    let response = await youtube.videos.list({
      part: ['snippet', 'contentDetails', 'status'],
      id: [videoId],
      auth: process.env.GOOGLE_API_KEY,
    });

    if (!response.data.items.length) {
      response = await youtube.videos.list({
        part: ['snippet', 'contentDetails', 'status'],
        id: [videoId],
        auth: oauth2Client,
      });

      if (!response.data.items.length) {
        return res.status(404).json({ error: 'Video tidak ditemukan' });
      }
    }

    const video = response.data.items[0];
    const duration = video.contentDetails.duration;
    const durationSeconds = parseDuration(duration);
    const formats = [
      { quality: '1080p', format: 'MP4', size: estimateFileSize(5000, durationSeconds), type: 'video', url },
      { quality: '720p', format: 'MP4', size: estimateFileSize(3000, durationSeconds), type: 'video', url },
      { quality: '480p', format: 'MP4', size: estimateFileSize(1500, durationSeconds), type: 'video', url },
      { quality: 'Best Audio', format: 'MP3', size: 'Auto Convert', type: 'audio', url }
    ];

    res.json({
      title: video.snippet.title,
      thumbnail: video.snippet.thumbnails.high.url,
      duration: durationSeconds ? new Date(durationSeconds * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
      previewUrl: url,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil informasi video', details: err.message });
  }
});

// === API: Download ===
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
    ? `${ytDlpPath} --extract-audio --audio-format mp3 -o "${outputFilePath}" "${url}"`
    : `${ytDlpPath} -f "bestvideo[height<=${parseInt(quality) || 'best'}]+bestaudio/best" --merge-output-format mp4 -o "${outputFilePath}" "${url}"`;

  try {
    await execAsync(command);
    const fileStream = fs.createReadStream(outputFilePath);
    const fileStats = fs.statSync(outputFilePath);

    res.setHeader('Content-Length', fileStats.size);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${sanitizedFilename}.${type === 'audio' ? 'mp3' : 'mp4'}"`);

    fileStream.pipe(res);

    fileStream.on('end', () => fs.unlink(outputFilePath, () => {}));
    fileStream.on('error', (err) => {
      res.status(500).json({ error: 'Gagal mengirim file', details: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengunduh', details: err.message });
  }
});

// === Duration Parser ===
function parseDuration(duration) {
  const match = duration.match(/PT(\d+H)?(\d+M)?(\d+S)?/);
  const hours = (match[1] ? parseInt(match[1]) : 0) || 0;
  const minutes = (match[2] ? parseInt(match[2]) : 0) || 0;
  const seconds = (match[3] ? parseInt(match[3]) : 0) || 0;
  return hours * 3600 + minutes * 60 + seconds;
}

// === Start Server ===
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
