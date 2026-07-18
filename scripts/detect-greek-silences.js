#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");

const COURSE_INDEX_URL = "https://downloads.languagetransfer.org/all-courses.json";

const options = parseArgs(process.argv.slice(2));

async function main() {
  const courseIndex = await fetchJson(COURSE_INDEX_URL);
  const baseUrl = courseIndex.casBaseURL.replace(/\/$/, "");
  const course = courseIndex.courses.find((entry) => entry.id === "greek");

  if (!course) {
    throw new Error("Could not find Greek course in course index");
  }

  const courseMeta = await fetchJson(`${baseUrl}/${course.meta.object}`);
  const outputPath = path.resolve(options.output);
  const cacheDir = path.resolve(options.cache);
  const pauseTimestampsByLesson = {};

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  for (let lessonIndex = 0; lessonIndex < courseMeta.lessons.length; lessonIndex += 1) {
    const lesson = courseMeta.lessons[lessonIndex];
    const variant = lesson.variants[options.quality];
    const lessonNumber = lessonIndex + 1;
    const audioPath = path.join(
      cacheDir,
      `greek-${String(lessonNumber).padStart(3, "0")}-${options.quality}.mp4`
    );

    console.log(`Lesson ${lessonNumber}/${courseMeta.lessons.length}: ${lesson.title}`);
    await downloadIfMissing(`${baseUrl}/${variant.object}`, audioPath, variant.filesize);

    const silences = await detectSilences(audioPath);
    pauseTimestampsByLesson[lessonNumber] = silences.map((silence) => silence.start);
    console.log(`  found ${silences.length} markers`);
  }

  await fs.writeFile(
    outputPath,
    `${JSON.stringify(pauseTimestampsByLesson, null, 2)}\n`
  );

  console.log(`Wrote auto-pause markers to ${outputPath}`);
}

function parseArgs(args) {
  const parsed = {
    quality: "hq",
    noise: "-40dB",
    duration: "1.2",
    output: path.join("assets", "data", "autopause", "greek.json"),
    cache: path.join(os.tmpdir(), "lt-app-greek-audio"),
  };

  for (const arg of args) {
    const [key, value] = arg.split("=");
    if (!key.startsWith("--") || !value) {
      throw new Error(`Invalid argument "${arg}". Use --name=value.`);
    }

    switch (key) {
      case "--quality":
        if (value !== "hq" && value !== "lq") {
          throw new Error("--quality must be hq or lq");
        }
        parsed.quality = value;
        break;
      case "--noise":
        parsed.noise = value;
        break;
      case "--duration":
        parsed.duration = value;
        break;
      case "--output":
        parsed.output = value;
        break;
      case "--cache":
        parsed.cache = value;
        break;
      default:
        throw new Error(`Unknown argument "${key}"`);
    }
  }

  return parsed;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function downloadIfMissing(url, destination, expectedSize) {
  const existing = await statOrNull(destination);
  if (existing && (!expectedSize || existing.size === expectedSize)) {
    console.log(`  using cached audio ${destination}`);
    return;
  }

  console.log(`  downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(destination, bytes);
}

async function statOrNull(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function detectSilences(audioPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-i",
      audioPath,
      "-af",
      `silencedetect=noise=${options.noise}:d=${options.duration}`,
      "-f",
      "null",
      "-",
    ]);

    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}\n${stderr}`));
        return;
      }
      resolve(parseSilencedetectOutput(stderr));
    });
  });
}

function parseSilencedetectOutput(output) {
  const silences = [];
  let current = null;

  for (const line of output.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      current = {
        start: Number.parseFloat(startMatch[1]),
      };
      continue;
    }

    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch && current) {
      current.end = Number.parseFloat(endMatch[1]);
      current.duration = Number.parseFloat(endMatch[2]);
      silences.push(current);
      current = null;
    }
  }

  return silences;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
