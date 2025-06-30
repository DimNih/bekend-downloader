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
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DOWNLOADS_DIR = path.join('/tmp', 'downloads');
const ytDlpPath = 'yt-dlp';
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

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
    const response = await axios.head(url, {
      maxRedirects: 0,
      validateStatus: null,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://www.instagram.com/',
      },
    });
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
        'Referer': 'https://www.instagram.com/',
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

const detectPlatform = (url) => {
  if (/youtube\.com|youtu\.be/.test(url)) return 'youtube';
  if (/tiktok\.com|vt\.tiktok\.com/.test(url)) return 'tiktok';
  if (/instagram\.com/.test(url)) return 'instagram';
  if (/facebook\.com|fb\.com/.test(url)) return 'facebook';
  return 'unknown';
};

const getCookiesHeader = () => {
  if (!fs.existsSync(COOKIES_PATH)) {
    console.warn(`[WARN] Cookies file not found at ${COOKIES_PATH}`);
    return null;
  }
  const cookiesContent = fs.readFileSync(COOKIES_PATH, 'utf8');
  const cookies = cookiesContent
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split('\t');
      if (parts.length >= 7) {
        return `${parts[5]}=${parts[6]}`;
      }
      return null;
    })
    .filter(Boolean)
    .join('; ');
  return cookies || null;
};

app.get('/api/proxy-stream', async (req, res) => {
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Stream URL is required' });
  }

  console.log(`[INFO] Proxying stream: ${url}`);

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Referer': 'https://www.instagram.com/',
    };

    const cookies = getCookiesHeader();
    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const response = await axios.get(url, {
      responseType: 'stream',
      headers,
      timeout: 10000,
    });

    res.set({
      'Content-Type': response.headers['content-type'] || 'application/x-mpegURL',
      'Access-Control-Allow-Origin': '*',
    });

    response.data.pipe(res);
  } catch (err) {
    console.error(`[ERROR] Proxy stream failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to proxy stream', details: err.message });
  }
});

app.post('/api/video-info', async (req, res) => {
  let { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);
  const platform = detectPlatform(url);
  const cookiesOption = fs.existsSync(COOKIES_PATH) ? `--cookies "${COOKIES_PATH}"` : '';
  const command = `${ytDlpPath} ${cookiesOption} --dump-json --no-warnings "${url}"`;

  console.log(`[INFO] Platform detected: ${platform}`);
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

    let bestVideoFormat = null;
    if (platform === 'tiktok' || platform === 'instagram') {
      try {
        const mp4Command = `${ytDlpPath} ${cookiesOption} -f "best[ext=mp4]" --get-url "${url}"`;
        console.log(`[INFO] Attempting to fetch MP4 URL: ${mp4Command}`);
        const { stdout: mp4Url } = await execAsync(mp4Command);
        if (mp4Url && mp4Url.trim()) {
          bestVideoFormat = { url: mp4Url.trim(), ext: 'mp4', protocol: 'https' };
          console.log(`[INFO] Direct MP4 URL fetched: ${mp4Url.trim()}`);
        } else {
          console.warn(`[WARN] No valid MP4 URL returned by yt-dlp`);
        }
      } catch (mp4Err) {
        console.warn(`[WARN] Failed to fetch direct MP4 for ${platform}: ${mp4Err.message}`);
      }
    }

    if (!bestVideoFormat) {
      bestVideoFormat = data.formats
        .filter(
          (f) =>
            f.vcodec !== 'none' &&
            f.url &&
            f.ext === 'mp4' &&
            (f.protocol === 'https' || f.protocol === 'http')
        )
        .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

      if (!bestVideoFormat && (platform === 'tiktok' || platform === 'instagram')) {
        bestVideoFormat = data.formats
          .filter((f) => f.vcodec !== 'none' && f.url && f.ext === 'mp4' && f.protocol.includes('m3u8'))
          .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
      }
    }

    let previewUrl = bestVideoFormat?.url || data.webpage_url || url;
    if (platform === 'tiktok' || platform === 'instagram') {
      if (previewUrl.includes('.m3u8')) {
        previewUrl = `http://localhost:8080/api/proxy-stream?url=${encodeURIComponent(previewUrl)}`;
        console.log(`[INFO] Proxied HLS previewUrl: ${previewUrl}`);
      } else {
        console.log(`[INFO] Using direct previewUrl: ${previewUrl}`);
      }
    }

    // Validate thumbnail
    const thumbnail = await validateThumbnail(data.thumbnail);

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
      thumbnail,
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
      previewUrl,
      platform,
    });
  } catch (err) {
    console.error(`[ERROR] Failed to fetch video info: ${err.message}`);
    console.error(`[ERROR] yt-dlp stderr: ${err.stderr || 'No stderr'}`);
    res.status(500).json({ error: 'Failed to fetch video info', details: err.message, stderr: err.stderr || 'No stderr' });
  }
});

app.post('/api/download', async (req, res) => {
  const { url, filename, type, quality } = req.body;
  if (!url || !filename || !type || !quality) {
    return res.status(400).json({ error: 'Parameters url, filename, type, and quality are required' });
  }

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});