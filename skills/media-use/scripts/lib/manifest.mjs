import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_FILE = "manifest.jsonl";
const INDEX_FILE = "index.md";

const TYPE_DIRS = {
  bgm: "audio/bgm",
  sfx: "audio/sfx",
  voice: "audio/voice",
  image: "images",
  icon: "images",
  brand: "images",
  video: "video",
};

export function mediaDir(projectDir) {
  return join(projectDir, ".media");
}

export function manifestPath(projectDir) {
  return join(mediaDir(projectDir), MANIFEST_FILE);
}

export function indexPath(projectDir) {
  return join(mediaDir(projectDir), INDEX_FILE);
}

export function typeSubdir(type) {
  const sub = TYPE_DIRS[type];
  if (!sub) throw new Error(`unknown media type: ${type}`);
  return sub;
}

export function typeDirPath(projectDir, type) {
  return join(mediaDir(projectDir), typeSubdir(type));
}

export function readManifest(projectDir) {
  const p = manifestPath(projectDir);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const records = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // ponytail: skip malformed lines, don't crash
    }
  }
  return records;
}

export function appendRecord(projectDir, record) {
  const dir = mediaDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const typeDir = typeDirPath(projectDir, record.type);
  mkdirSync(typeDir, { recursive: true });

  const p = manifestPath(projectDir);
  const line = JSON.stringify(record) + "\n";
  appendFileSync(p, line);
}

// Match prompts forgivingly. Agents rarely re-emit a byte-identical intent, so
// keying cache lookups on exact equality meant "Calm piano" and "calm  piano"
// re-searched and re-downloaded. Normalize (trim, lowercase, collapse internal
// whitespace) on both sides; the raw prompt is still stored for audit.
export function normalizePrompt(prompt) {
  return String(prompt ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function findByPrompt(projectDir, prompt, type) {
  const key = normalizePrompt(prompt);
  if (!key) return null;
  const records = readManifest(projectDir);
  return (
    records.find(
      (r) => normalizePrompt(r.provenance?.prompt) === key && (type == null || r.type === type),
    ) || null
  );
}

export function findByEntity(projectDir, entity) {
  const lower = entity.toLowerCase();
  const records = readManifest(projectDir);
  return records.find((r) => r.entity && r.entity.toLowerCase() === lower) || null;
}

export function nextId(projectDir, type) {
  const records = readManifest(projectDir);
  const prefix = type;
  let max = 0;
  for (const r of records) {
    if (r.type !== type) continue;
    const m = r.id?.match(new RegExp(`^${prefix}_(\\d+)$`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}_${String(max + 1).padStart(3, "0")}`;
}
