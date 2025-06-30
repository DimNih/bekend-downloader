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
const ytDlpPath = 'yt-dlp';

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const execAsync = promisify(exec);

const sanitizeFilename = (filename) => {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, '_')
    .replace(/\.(mp3|mp4)$/i, '')
    .substring(0, 150);
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

// 🔥 API Info Video
app.post('/api/video-info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);
  const command = `${ytDlpPath} --dump-json --no-warnings "${url}"`;

  try {
    const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 * 20 });
    const data = JSON.parse(stdout);

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
      title: data.title || 'Unknown Title',
      thumbnail: data.thumbnail || '',
      previewUrl: previewUrl,
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal mengambil info video', details: err.message });
  }
});

// 🔥 API Download
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
    : `${ytDlpPath} -f "bestvideo[height<=${parseInt(quality)}]+bestaudio/best" --merge-output-format mp4 -o "${outputFilePath}" "${url}"`;

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

    fileStream.pipe(res);

    fileStream.on('end', () => {
      fs.unlink(outputFilePath, () => {});
    });

    fileStream.on('error', (err) => {
      res.status(500).json({ error: 'Gagal mengirim file', details: err.message });
    });
  } catch (err) {
    res.status(500).json({ error: 'Gagal download', details: err.message });
  }
});

// 🔥 API Stream Preview
app.get('/api/stream-preview', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL diperlukan');

  try {
    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send('Gagal memuat preview');
  }
});

// 🔥 Run Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});
