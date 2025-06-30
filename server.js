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
      return await resolveRedirect(response.headers.location); // Follow redirects recursively
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

// 🔥 API Video Info
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
      .filter((f) => f.vcodec !== 'none' && f.acodec !== 'none' && f.ext === 'mp4' && f.height)
      .sort((a, b) => b.height - a.height)
      .forEach((f) => {
        const quality = `${f.height}p`;
        if (!videoQualities.has(quality)) {
          let size = f.filesize
            ? (f.filesize / (1024 * 1024)).toFixed(2) + 'MB'
            : estimateFileSize(f.tbr || 128, duration);

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
      .filter((f) => f.acodec !== 'none' && f.ext === 'm4a')
      .sort((a, b) => (b.abr || 0) - (a.abr || 0) || (b.filesize || 0) - (a.filesize || 0))[0];

    if (bestAudio) {
      let audioSize = bestAudio.filesize
        ? (bestAudio.filesize / (1024 * 1024)).toFixed(2) + 'MB'
        : estimateFileSize(bestAudio.abr || 128, duration);

      formats.push({
        quality: 'Best Audio',
        format: 'MP3',
        size: audioSize,
        url: data.webpage_url || url,
        type: 'audio',
      });
    }

    // Select a low-quality MP4 format for preview
    const previewFormat = data.formats.find(
      (f) =>
        f.vcodec !== 'none' &&
        f.acodec !== 'none' &&
        f.ext === 'mp4' &&
        f.height <= 360 &&
        f.url &&
        f.protocol?.includes('http') // Ensure it's a direct HTTP/HTTPS URL
    );

    // Construct the stream URL for the preview
    const previewUrl = previewFormat
      ? `/api/stream-preview?url=${encodeURIComponent(previewFormat.url)}`
      : '';

    res.json({
      title: data.title || 'Unknown Title',
      thumbnail: data.thumbnail || '',
      previewUrl,
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
    });
  } catch (err) {
    console.error('Video info error:', err);
    res.status(500).json({ error: 'Gagal mengambil info video', details: err.message });
  }
});

// 🔥 API Stream Preview
app.get('/api/stream-preview', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL diperlukan');

  try {
    const resolvedUrl = await resolveRedirect(decodeURIComponent(url));
    const response = await axios({
      method: 'get',
      url: resolvedUrl,
      responseType: 'stream',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'video/mp4,video/webm',
      },
      timeout: 15000,
    });

    const contentType = response.headers['content-type'] || 'video/mp4';
    if (!contentType.includes('video')) {
      return res.status(400).send('Invalid video content type');
    }

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    response.data.pipe(res);

    response.data.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).send('Gagal memuat preview');
    });
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).send('Gagal memuat preview: ' + err.message);
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

// 🔥 Run Server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});