import express from 'express';
import { promisify } from 'util';
import { exec } from 'child_process';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import { load } from 'cheerio';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables from .env file

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DOWNLOADS_DIR = path.join('/tmp', 'downloads');
const ytDlpPath = 'yt-dlp';
const proxy = process.env.PROXY_URL || ''; // Get proxy from environment variable

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  console.log(`[INFO] Download folder created at ${DOWNLOADS_DIR}`);
}

const execAsync = promisify(exec);

const sanitizeFilename = (filename) => {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{2700}-\u{27BF}]/gu, '')
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
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

const validateThumbnail = async (thumbnailUrl) => {
  if (!thumbnailUrl) return '';
  try {
    const response = await axios.head(thumbnailUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      },
      timeout: 5000,
    });
    if (response.status === 200 && response.headers['content-type']?.includes('image')) {
      return thumbnailUrl;
    }
    console.warn(`[WARN] Thumbnail invalid or inaccessible: ${thumbnailUrl}`);
    return '';
  } catch (err) {
    console.warn(`[WARN] Thumbnail validation failed: ${err.message}`);
    return '';
  }
};

const estimateFileSize = (bitrateKbps, durationSeconds) => {
  const sizeInBits = bitrateKbps * 1000 * durationSeconds;
  const sizeInBytes = sizeInBits / 8;
  const sizeInMB = sizeInBytes / (1024 * 1024);
  return sizeInMB.toFixed(2) + 'MB';
};

const isYouTubeUrl = (url) => {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/.test(url);
};

const getSaveFromVideoInfo = async (url) => {
  try {
    const response = await axios.post(
      'https://www.savefrom.net/api/convert/',
      { url },
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Content-Type': 'application/json',
          'Referer': 'https://www.savefrom.net/',
          'Origin': 'https://www.savefrom.net',
        },
        timeout: 10000,
      }
    );

    const data = response.data;
    if (!data || !data.url || data.status !== 'success') {
      throw new Error('No valid download links found from SaveFrom.net');
    }

    const title = data.meta?.title || 'Unknown Title';
    const thumbnail = data.meta?.thumbnail || '';
    const duration = data.meta?.duration || '00:00:00';

    const formats = data.url.map((item) => ({
      quality: item.quality || 'Unknown',
      format: item.type === 'audio' ? 'MP3' : 'MP4',
      size: item.size ? (item.size / (1024 * 1024)).toFixed(2) + 'MB' : 'Unknown Size',
      url: item.url,
      type: item.type === 'audio' ? 'audio' : 'video',
    }));

    if (formats.length === 0) throw new Error('No download links found');

    return {
      title,
      thumbnail: await validateThumbnail(thumbnail),
      duration,
      formats,
      previewUrl: formats.find((f) => f.type === 'video')?.url || url,
    };
  } catch (err) {
    console.error(`[ERROR] SaveFrom.net scraping failed: ${err.message}`);
    throw err;
  }
};

app.post('/api/video-info', async (req, res) => {
  let { url, platform } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);

  if (platform === 'youtube' || isYouTubeUrl(url)) {
    try {
      const videoInfo = await getSaveFromVideoInfo(url);
      console.log(`[INFO] Successfully retrieved SaveFrom.net info: ${videoInfo.title}`);
      return res.json(videoInfo);
    } catch (err) {
      console.error(`[ERROR] SaveFrom.net scraping failed, falling back to yt-dlp: ${err.message}`);
    }
  }

  const proxyOption = proxy ? `--proxy "${proxy}"` : '';
  const command = `${ytDlpPath} --dump-json --no-warnings ${proxyOption} "${url}"`;
  console.log(`[INFO] Executing command: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 20 });
    if (stderr) console.warn(`[WARN] yt-dlp stderr: ${stderr}`);
    const data = JSON.parse(stdout);

    console.log(`[INFO] Successfully retrieved info: ${data.title}`);
    console.log('Extracted data:', JSON.stringify(data, null, 2));

    const formats = [];
    const videoQualities = new Set();
    const duration = data.duration || 0;

    const bestVideoFormat =
      data.formats
        .filter(
          (f) =>
            f.vcodec !== 'none' &&
            f.acodec !== 'none' &&
            f.url &&
            f.ext === 'mp4' &&
            (f.protocol === 'https' || f.protocol === 'http')
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0] ||
      data.formats
        .filter(
          (f) =>
            f.vcodec !== 'none' &&
            f.url &&
            f.ext === 'mp4' &&
            (f.protocol === 'https' || f.protocol === 'http')
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

    console.log('Best video format:', bestVideoFormat);

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
            url: f.url || data.webpage_url || url,
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
        url: bestAudio.url || data.webpage_url || url,
        type: 'audio',
      });
    }

    const thumbnail = data.thumbnail || (data.thumbnails && data.thumbnails[0]?.url) || '';

    res.json({
      title: data.title || 'Unknown Title',
      thumbnail: await validateThumbnail(thumbnail),
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
      previewUrl: bestVideoFormat?.url || data.url || data.webpage_url || url,
    });
  } catch (err) {
    console.error(`[ERROR] Failed to fetch video info: ${err.message}`);
    console.error(`[ERROR] yt-dlp stderr: ${err.stderr || 'No stderr'}`);
    res.status(500).json({ error: 'Failed to fetch video info', details: err.message, stderr: err.stderr || 'No stderr' });
  }
});

app.post('/api/download', async (req, res) => {
  const { url, filename, type, quality, platform } = req.body;
  if (!url || !filename || !type || !quality) {
    return res.status(400).json({ error: 'Parameters url, filename, type, and quality are required' });
  }

  if (platform === 'youtube' || isYouTubeUrl(url)) {
    try {
      const videoInfo = await getSaveFromVideoInfo(url);
      const format = videoInfo.formats.find((f) => f.type === type && f.quality === quality);
      if (!format) {
        return res.status(400).json({ error: `No matching format found for quality: ${quality}` });
      }

      const response = await axios({
        url: format.url,
        method: 'GET',
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        },
      });

      const sanitizedFilename = sanitizeFilename(filename);
      res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(sanitizedFilename)}.${type === 'audio' ? 'mp3' : 'mp4'}"`
      );

      response.data.pipe(res);
      console.log(`[INFO] Streaming SaveFrom.net file: ${sanitizedFilename}`);
    } catch (err) {
      console.error(`[ERROR] SaveFrom.net download failed: ${err.message}`);
      res.status(500).json({ error: 'Download failed', details: err.message });
    }
    return;
  }

  const sanitizedFilename = sanitizeFilename(filename);
  const outputFilePath = path.join(
    DOWNLOADS_DIR,
    `${sanitizedFilename}.${type === 'audio' ? 'mp3' : 'mp4'}`
  );

  const proxyOption = proxy ? `--proxy "${proxy}"` : '';
  const command =
    type === 'audio'
      ? `${ytDlpPath} --extract-audio --audio-format mp3 ${proxyOption} -o "${outputFilePath}" "${url}"`
      : `${ytDlpPath} -f "best[height<=${parseInt(quality)}][ext=mp4]/best[ext=mp4]/best" --merge-output-format mp4 ${proxyOption} -o "${outputFilePath}" "${url}"`;

  console.log(`[INFO] Executing download command: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command);
    console.log(`[INFO] yt-dlp stdout: ${stdout}`);
    if (stderr) console.warn(`[WARN] yt-dlp stderr: ${stderr}`);

    const fileStream = fs.createReadStream(outputFilePath);
    const fileStats = fs.statSync(outputFilePath);

    res.setHeader('Content-Length', fileStats.size);
    res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(sanitizedFilename)}.${type === 'audio' ? 'mp3' : 'mp4'}"`
    );

    console.log(`[INFO] Starting file transfer: ${outputFilePath}`);

    fileStream.pipe(res);

    fileStream.on('end', () => {
      console.log(`[INFO] File ${outputFilePath} sent and deleted.`);
      fs.unlink(outputFilePath, () => {});
    });

    fileStream.on('error', (err) => {
      console.error(`[ERROR] Failed to send file: ${err.message}`);
      res.status(500).json({ error: 'Failed to send file', details: err.message });
    });
  } catch (err) {
    console.error(`[ERROR] Download failed: ${err.message}`);
    console.error(`[ERROR] yt-dlp stderr: ${err.stderr || 'No stderr'}`);
    res.status(500).json({ error: 'Download failed', details: err.message, stderr: err.stderr || 'No stderr' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
