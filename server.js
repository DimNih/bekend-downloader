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

// API: Get video info
app.post('/api/video-info', async (req, res) => {
  let { url } = req.body; 
  if (!url) return res.status(400).json({ error: 'URL diperlukan' });

  url = await resolveRedirect(url);
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

    // Select the best video format for preview (prioritize MP4 with HTTP/HTTPS protocol)
    const bestVideoFormat = data.formats
      .filter(
        (f) =>
          f.vcodec !== 'none' &&
          f.url &&
          f.ext === 'mp4' &&
          (f.protocol === 'https' || f.protocol === 'http')
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
      thumbnail: await validateThumbnail(data.thumbnail), // Updated to use validateThumbnail
      duration: duration ? new Date(duration * 1000).toISOString().substr(11, 8) : '00:00:00',
      formats,
      previewUrl: bestVideoFormat?.url || data.webpage_url || url, // Fallback to webpage_url if no streamable URL
    });
  } catch (err) {
    console.error(`[ERROR] Failed to fetch video info: ${err.message}`);
    console.error(`[ERROR] yt-dlp stderr: ${err.stderr || 'No stderr'}`);
    res.status(500).json({ error: 'Failed to fetch video info', details: err.message, stderr: err.stderr || 'No stderr' });
  }
});

// API: Download video/audio
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

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});