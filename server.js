import express from 'express';
import { promisify } from 'util';
import { exec } from 'child_process';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import axios from 'axios';
import * as cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DOWNLOADS_DIR = path.join('/tmp', 'downloads');
const ytDlpPath = 'yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'youtube.com_cookies.txt');

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

const isTikTokUrl = (url) => {
  return /^(https?:\/\/)?(www\.)?(tiktok\.com|vt\.tiktok\.com)\/.+/.test(url);
};

// SnapSave Web Scraping for YouTube
const getSnapSaveVideoInfo = async (url) => {
  try {
    const response = await axios.post(
      'https://snapsave.app/action.php?lang=en',
      new URLSearchParams({ url }),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://snapsave.app/',
          'Origin': 'https://snapsave.app',
        },
      }
    );

    const $ = cheerio.load(response.data);
    const title = $('h1.video-title').text().trim() || 'Unknown Title';
    const thumbnail = $('img.video-thumbnail').attr('src') || '';
    const duration = $('span.video-duration').text().trim() || '00:00:00';

    const formats = [];
    $('table.download-table tr').each((_, element) => {
      const quality = $(element).find('td.quality').text().trim() || 'Unknown';
      const format = $(element).find('td.format').text().trim() || 'MP4';
      const size = $(element).find('td.size').text().trim() || 'Unknown Size';
      const downloadUrl = $(element).find('a.download-link').attr('href');
      const type = quality.includes('Audio') ? 'audio' : 'video';

      if (downloadUrl) {
        formats.push({
          quality: quality.includes('Audio') ? 'Best Audio' : quality,
          format: type === 'audio' ? 'MP3' : 'MP4',
          size,
          url: downloadUrl,
          type,
        });
      }
    });

    if (formats.length === 0) {
      throw new Error('No download links found');
    }

    return {
      title,
      thumbnail: await validateThumbnail(thumbnail),
      duration,
      formats,
      previewUrl: formats.find(f => f.type === 'video')?.url || url,
    };
  } catch (err) {
    console.error(`[ERROR] SnapSave scraping failed: ${err.message}`);
    throw err;
  }
};

// SnapTik Web Scraping for TikTok
const getSnapTikVideoInfo = async (url) => {
  try {
    const response = await axios.post(
      'https://snaptik.app/action.php', // Adjust based on actual SnapTik endpoint
      new URLSearchParams({ url }),
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://snaptik.app/',
          'Origin': 'https://snaptik.app',
        },
      }
    );

    const $ = cheerio.load(response.data);
    const title = $('h1.video-title').text().trim() || 'Unknown Title';
    const thumbnail = $('img.video-thumbnail').attr('src') || '';
    const duration = $('span.video-duration').text().trim() || '00:00:00';

    const formats = [];
    $('div.download-item').each((_, element) => {
      const quality = $(element).find('span.quality').text().trim() || 'Unknown';
      const downloadUrl = $(element).find('a.download-link').attr('href');
      const type = quality.includes('Audio') ? 'audio' : 'video';
      const size = $(element).find('span.size').text().trim() || 'Unknown Size';

      if (downloadUrl && downloadUrl.includes('.mp4')) {
        formats.push({
          quality: quality.includes('Audio') ? 'Best Audio' : quality || '720p',
          format: type === 'audio' ? 'MP3' : 'MP4',
          size,
          url: downloadUrl,
          type,
        });
      }
    });

    if (formats.length === 0) {
      throw new Error('No download links found');
    }

    return {
      title,
      thumbnail: await validateThumbnail(thumbnail),
      duration,
      formats,
      previewUrl: formats.find(f => f.type === 'video')?.url || url,
    };
  } catch (err) {
    console.error(`[ERROR] SnapTik scraping failed: ${err.message}`);
    throw err;
  }
};

// API: Get video info
app.post('/api/video-info', async (req, res) => {
  let { url, platform } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);

  // Handle YouTube
  if (platform === 'youtube' || isYouTubeUrl(url)) {
    try {
      const videoInfo = await getSnapSaveVideoInfo(url);
      console.log(`[INFO] Successfully retrieved SnapSave info: ${videoInfo.title}`);
      return res.json(videoInfo);
    } catch (err) {
      console.error(`[ERROR] SnapSave scraping failed, falling back to yt-dlp: ${err.message}`);
    }
  }

  // Handle TikTok
  if (platform === 'tiktok' || isTikTokUrl(url)) {
    try {
      const videoInfo = await getSnapTikVideoInfo(url);
      console.log(`[INFO] Successfully retrieved SnapTik info: ${videoInfo.title}`);
      return res.json(videoInfo);
    } catch (err) {
      console.error(`[ERROR] SnapTik scraping failed, falling back to yt-dlp: ${err.message}`);
    }
  }

  // Fallback to yt-dlp for other platforms or failed scraping
  const cookiesOption = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const command = `${ytDlpPath} ${cookiesOption} --dump-json --no-warnings "${url}"`;

  console.log(`[INFO] Executing command: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024 * 20 });
    if (stderr) {
      console.warn(`[WARN] yt-dlp stderr: ${stderr}`);
    }
    const data = JSON.parse(stdout);

    console.log(`[INFO] Successfully retrieved info: ${data.title}`);

    const formats = [];
    const videoQualities = new Set();
    const duration = data.duration || 0;

    const bestVideoFormat = data.formats
      .filter(
        (f) =>
          f.vcodec !== 'none' &&
          f.url &&
          f.ext === 'mp4' &&
          (f.protocol === 'https' || f.protocol === 'http') &&
          !f.url.includes('.m3u8') // Prefer non-HLS for preview
      )
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

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
      thumbnail: await validateThumbnail(data.thumbnail),
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
      previewUrl: bestVideoFormat?.url || data.webpage_url || url,
      platform, // Include platform for frontend
    });
  } catch (err) {
    console.error(`[ERROR] Failed to fetch video info: ${err.message}`);
    console.error(`[ERROR] yt-dlp stderr: ${err.stderr || 'No stderr'}`);
    res.status(500).json({ error: 'Failed to fetch video info', details: err.message, stderr: err.stderr || 'No stderr' });
  }
});

// API: Download video/audio
app.post('/api/download', async (req, res) => {
  const { url, filename, type, quality, platform } = req.body;
  if (!url || !filename || !type || !quality) {
    return res.status(400).json({ error: 'Parameters url, filename, type, and quality are required' });
  }

  if (platform === 'youtube' || isYouTubeUrl(url)) {
    try {
      const videoInfo = await getSnapSaveVideoInfo(url);
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
      console.log(`[INFO] Streaming SnapSave file: ${sanitizedFilename}`);
    } catch (err) {
      console.error(`[ERROR] SnapSave download failed: ${err.message}`);
    }
  }

  if (platform === 'tiktok' || isTikTokUrl(url)) {
    try {
      const videoInfo = await getSnapTikVideoInfo(url);
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
          'Referer': 'https://www.tiktok.com/',
        },
      });

      const sanitizedFilename = sanitizeFilename(filename);
      res.setHeader('Content-Type', type === 'audio' ? 'audio/mpeg' : 'video/mp4');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(sanitizedFilename)}.${type === 'audio' ? 'mp3' : 'mp4'}"`
      );

      response.data.pipe(res);
      console.log(`[INFO] Streaming SnapTik file: ${sanitizedFilename}`);
    } catch (err) {
      console.error(`[ERROR] SnapTik download failed: ${err.message}`);
    }
  }

  // Fallback to yt-dlp
  const sanitizedFilename = sanitizeFilename(filename);
  const outputFilePath = path.join(
    DOWNLOADS_DIR,
    `${sanitizedFilename}.${type === 'audio' ? 'mp3' : 'mp4'}`
  );

  const cookiesOption = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const command = type === 'audio'
    ? `${ytDlpPath} ${cookiesOption} --extract-audio --audio-format mp3 -o "${outputFilePath}" "${url}"`
    : `${ytDlpPath} ${cookiesOption} -f "best[height<=${parseInt(quality)}][ext=mp4]/best[ext=mp4]/best" --merge-output-format mp4 -o "${outputFilePath}" "${url}"`;

  console.log(`[INFO] Executing download command: ${command}`);

  try {
    const { stdout, stderr } = await execAsync(command);
    console.log(`[INFO] yt-dlp stdout: ${stdout}`);
    if (stderr) {
      console.warn(`[WARN] yt-dlp stderr: ${stderr}`);
    }

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

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});