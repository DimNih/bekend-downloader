import express from 'express';
import { promisify } from 'util';
import { exec } from 'child_process';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';

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
  console.log(`[INFO] Folder download dibuat di ${DOWNLOADS_DIR}`);
}

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

// ==========================================
// ✅ API: Get video info
// ==========================================
app.post('/api/video-info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);
  const command = `${ytDlpPath} --dump-json --no-warnings "${url}"`;

  console.log(`[INFO] Menjalankan command: ${command}`);

  try {
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

    res.json({
      title: data.title || 'Unknown Title',
      thumbnail: data.thumbnail || '',
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
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
    : `${ytDlpPath} --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" -f "bestvideo[height<=${parseInt(quality)}]+bestaudio/best/best" --merge-output-format mp4 -o "${outputFilePath}" "${url}"`;

  console.log(`[INFO] Menjalankan command download: ${command}`);

  try {
    await execAsync(command);

    const fileStream = fs.createReadStream(outputFilePath);
    const fileStats = fs.statSync(outputFilePath);

    res.setHeader('Content-Length', fileStats.size);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizedFilename}.${type === 'audio' ? 'mp3' : 'mp4'}"`
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
// ✅ Jalankan server
// ==========================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
