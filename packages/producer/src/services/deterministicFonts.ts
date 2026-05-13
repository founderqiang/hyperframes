import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseHTML } from "linkedom";
import { EMBEDDED_FONT_DATA } from "./fontData.generated.js";

type FontFaceSpec = {
  weight: string;
  style?: "normal" | "italic";
};

type CanonicalFontSpec = {
  packageName: string;
  faces: FontFaceSpec[];
};

/**
 * Family names that resolve to a host-OS font (or a CSS generic that the
 * browser substitutes with a host-OS font). Exported so plan-time validators
 * can reject them as primary families in distributed renders.
 *
 * Lower-cased — call `normalizeFamilyName` on declared values before lookup.
 */
export const GENERIC_FAMILIES: ReadonlySet<string> = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "emoji",
  "math",
  "fangsong",
  "-apple-system",
  "blinkmacsystemfont",
]);

/**
 * Parse a single `font-family` value (e.g. `"Inter", -apple-system,
 * sans-serif`) into a list of unquoted family names in declaration order.
 * Whitespace and surrounding `"…"` / `'…'` quotes are stripped; case is
 * preserved. Pass each name through `normalizeFamilyName` for case-
 * insensitive comparisons.
 */
export function parseFontFamilyValue(value: string): string[] {
  return value
    .split(",")
    .map((piece) => piece.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim())
    .filter((piece) => piece.length > 0);
}

/** Surfaces font-family is declared on in served HTML. */
export type FontFamilySurface = "font-family" | "data-font-family";

/**
 * Iterate every font-family declaration in a compiled HTML document. Yields
 * each declaration's surface (CSS property vs HTML attribute), raw value,
 * and the parsed family list. Used by both the @font-face injector and the
 * plan-time validator so they read the same surface area.
 */
export function* iterateFontFamilyDeclarations(
  html: string,
): Generator<{ surface: FontFamilySurface; declaration: string; families: string[] }, void, void> {
  const sources: ReadonlyArray<readonly [RegExp, FontFamilySurface]> = [
    [/font-family\s*:\s*([^;}{]+)[;}]?/gi, "font-family"],
    [/data-font-family=["']([^"']+)["']/gi, "data-font-family"],
  ];
  for (const [regex, surface] of sources) {
    for (const match of html.matchAll(regex)) {
      const declaration = match[1] ?? "";
      yield { surface, declaration, families: parseFontFamilyValue(declaration) };
    }
  }
}

const CANONICAL_FONTS: Record<string, CanonicalFontSpec> = {
  inter: {
    packageName: "@fontsource/inter",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  montserrat: {
    packageName: "@fontsource/montserrat",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  outfit: {
    packageName: "@fontsource/outfit",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  nunito: {
    packageName: "@fontsource/nunito",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  oswald: {
    packageName: "@fontsource/oswald",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  "league-gothic": {
    packageName: "@fontsource/league-gothic",
    faces: [{ weight: "400" }],
  },
  "archivo-black": {
    packageName: "@fontsource/archivo-black",
    faces: [{ weight: "400" }],
  },
  "space-mono": {
    packageName: "@fontsource/space-mono",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  "ibm-plex-mono": {
    packageName: "@fontsource/ibm-plex-mono",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  "jetbrains-mono": {
    packageName: "@fontsource/jetbrains-mono",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  "eb-garamond": {
    packageName: "@fontsource/eb-garamond",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  "playfair-display": {
    packageName: "@fontsource/playfair-display",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  "source-code-pro": {
    packageName: "@fontsource/source-code-pro",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  "noto-sans-jp": {
    packageName: "@fontsource/noto-sans-jp",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  roboto: {
    packageName: "@fontsource/roboto",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  "open-sans": {
    packageName: "@fontsource/open-sans",
    faces: [{ weight: "400" }, { weight: "700" }],
  },
  lato: {
    packageName: "@fontsource/lato",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
  poppins: {
    packageName: "@fontsource/poppins",
    faces: [{ weight: "400" }, { weight: "700" }, { weight: "900" }],
  },
};

const FONT_ALIASES: Record<string, keyof typeof CANONICAL_FONTS> = {
  inter: "inter",
  "helvetica neue": "inter",
  helvetica: "inter",
  arial: "inter",
  "helvetica bold": "inter",
  montserrat: "montserrat",
  futura: "montserrat",
  "din alternate": "montserrat",
  "arial black": "montserrat",
  outfit: "outfit",
  nunito: "nunito",
  oswald: "oswald",
  "bebas neue": "league-gothic",
  "league gothic": "league-gothic",
  "archivo black": "archivo-black",
  "space mono": "space-mono",
  "ibm plex mono": "ibm-plex-mono",
  "jetbrains mono": "jetbrains-mono",
  "courier new": "jetbrains-mono",
  courier: "jetbrains-mono",
  "eb garamond": "eb-garamond",
  garamond: "eb-garamond",
  "playfair display": "playfair-display",
  "source code pro": "source-code-pro",
  "noto sans jp": "noto-sans-jp",
  "noto sans japanese": "noto-sans-jp",
  roboto: "roboto",
  "open sans": "open-sans",
  lato: "lato",
  poppins: "poppins",
  "segoe ui": "roboto",
};

function normalizeFamilyName(family: string): string {
  return family
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim()
    .toLowerCase();
}

function fontDataUri(
  packageName: string,
  weight: string,
  style: "normal" | "italic" = "normal",
): string {
  const key = `${packageName}:${weight}:${style}`;
  const uri = EMBEDDED_FONT_DATA.get(key);
  if (!uri) {
    throw new Error(
      `No embedded font data for ${key}. Regenerate with: tsx scripts/generate-font-data.ts`,
    );
  }
  return uri;
}

function extractExistingFontFaces(html: string): Set<string> {
  const families = new Set<string>();
  const fontFaceRegex = /@font-face\s*\{[\s\S]*?font-family\s*:\s*([^;]+);[\s\S]*?\}/gi;
  for (const match of html.matchAll(fontFaceRegex)) {
    const raw = match[1] || "";
    const normalized = normalizeFamilyName(raw);
    if (normalized) {
      families.add(normalized);
    }
  }
  return families;
}

function extractRequestedFontFamilies(html: string): Map<string, string> {
  const requested = new Map<string, string>();
  for (const { families } of iterateFontFamilyDeclarations(html)) {
    for (const originalCase of families) {
      const normalized = originalCase.toLowerCase();
      if (!normalized || GENERIC_FAMILIES.has(normalized)) continue;
      if (!requested.has(normalized)) requested.set(normalized, originalCase);
    }
  }
  return requested;
}

function buildFontFaceRule(familyName: string, src: string, weight: string, style: string): string {
  return [
    "@font-face {",
    `  font-family: "${familyName}";`,
    `  src: url("${src}") format("woff2");`,
    `  font-style: ${style};`,
    `  font-weight: ${weight};`,
    "  font-display: block;",
    "}",
  ].join("\n");
}

async function buildFontFaceCss(requestedFamilies: Map<string, string>): Promise<{
  css: string;
  unresolved: string[];
}> {
  const rules: string[] = [];
  const unresolved: string[] = [];

  for (const [normalizedFamily, originalCaseFamily] of requestedFamilies) {
    // Path 1: pre-bundled fonts via FONT_ALIASES
    const canonicalKey = FONT_ALIASES[normalizedFamily];
    if (canonicalKey) {
      const canonical = CANONICAL_FONTS[canonicalKey];
      if (!canonical) continue;
      for (const face of canonical.faces) {
        const style = face.style || "normal";
        const src = fontDataUri(canonical.packageName, face.weight, style);
        rules.push(buildFontFaceRule(originalCaseFamily, src, face.weight, style));
      }
      continue;
    }

    // Path 2: fetch from Google Fonts (with local cache)
    const googleFaces = await fetchGoogleFont(originalCaseFamily);
    if (googleFaces.length > 0) {
      for (const face of googleFaces) {
        rules.push(buildFontFaceRule(originalCaseFamily, face.dataUri, face.weight, face.style));
      }
      continue;
    }

    // Neither path resolved
    unresolved.push(originalCaseFamily);
  }

  return {
    css: rules.join("\n\n").trim(),
    unresolved: unresolved.sort(),
  };
}

function warnUnresolvedFonts(unresolved: string[]): void {
  const mapped = Object.entries(FONT_ALIASES)
    .reduce<string[]>((acc, [alias, canonical]) => {
      const display = alias === canonical ? alias : `${alias} → ${canonical}`;
      if (!acc.includes(display)) acc.push(display);
      return acc;
    }, [])
    .sort();
  console.warn(
    `[Compiler] No deterministic font mapping for: ${unresolved.join(", ")}\n` +
      `  Mapped fonts: ${mapped.join(", ")}\n` +
      `  To fix, pick one:\n` +
      `    1. Use a mapped font name instead (see list above)\n` +
      `    2. Add a @font-face block in your HTML with a local or hosted font file\n` +
      `    3. Install the font locally on the render machine (Docker: add to Dockerfile)\n` +
      `    4. Add an alias to FONT_ALIASES in deterministicFonts.ts (for contributors)\n` +
      `  Docs: https://hyperframes.heygen.com/docs/fonts`,
  );
}

// ---------------------------------------------------------------------------
// Google Fonts on-demand fetch + local cache
// ---------------------------------------------------------------------------

const GOOGLE_FONTS_CACHE_DIR = join(homedir(), ".cache", "hyperframes", "fonts");

// Chrome UA triggers woff2 responses from Google Fonts CSS API
const WOFF2_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function fontSlug(familyName: string): string {
  return familyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function fontCacheDir(slug: string): string {
  const dir = join(GOOGLE_FONTS_CACHE_DIR, slug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function cachedWoff2Path(slug: string, weight: string, style: string): string {
  return join(fontCacheDir(slug), `${weight}-${style}.woff2`);
}

type GoogleFontFace = {
  weight: string;
  style: string;
  dataUri: string;
};

async function fetchGoogleFont(familyName: string): Promise<GoogleFontFace[]> {
  const slug = fontSlug(familyName);
  const encodedFamily = encodeURIComponent(familyName);
  const url = `https://fonts.googleapis.com/css2?family=${encodedFamily}:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700`;

  let cssText: string;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": WOFF2_USER_AGENT },
    });
    if (!res.ok) {
      return [];
    }
    cssText = await res.text();
  } catch {
    return [];
  }

  // Parse @font-face blocks from the CSS response
  const faceRegex =
    /@font-face\s*\{[^}]*font-style:\s*(normal|italic)[^}]*font-weight:\s*(\d+)[^}]*src:\s*url\(([^)]+)\)\s*format\(['"]woff2['"]\)[^}]*\}/gi;

  const faces: GoogleFontFace[] = [];

  for (const match of cssText.matchAll(faceRegex)) {
    const style = match[1] || "normal";
    const weight = match[2] || "400";
    const woff2Url = match[3] || "";

    if (!woff2Url) continue;

    const cachePath = cachedWoff2Path(slug, weight, style);

    // Check cache first
    if (!existsSync(cachePath)) {
      try {
        const fontRes = await fetch(woff2Url);
        if (!fontRes.ok) continue;
        const buffer = Buffer.from(await fontRes.arrayBuffer());
        writeFileSync(cachePath, buffer);
      } catch {
        continue;
      }
    }

    const fontBytes = readFileSync(cachePath);
    const dataUri = `data:font/woff2;base64,${fontBytes.toString("base64")}`;
    faces.push({ weight, style, dataUri });
  }

  if (faces.length > 0) {
    console.log(
      `[Compiler] Fetched ${faces.length} font face(s) for "${familyName}" from Google Fonts (cached to ${fontCacheDir(slug)})`,
    );
  }

  return faces;
}

// ---------------------------------------------------------------------------

export async function injectDeterministicFontFaces(html: string): Promise<string> {
  const existingFaces = extractExistingFontFaces(html);
  const requestedFamilies = extractRequestedFontFamilies(html);
  const pendingFamilies = new Map<string, string>();

  for (const [normalizedFamily, originalCaseFamily] of requestedFamilies) {
    if (!existingFaces.has(normalizedFamily)) {
      pendingFamilies.set(normalizedFamily, originalCaseFamily);
    }
  }

  if (pendingFamilies.size === 0) {
    return html;
  }

  const { css, unresolved } = await buildFontFaceCss(pendingFamilies);
  if (!css) {
    if (unresolved.length > 0) {
      warnUnresolvedFonts(unresolved);
    }
    return html;
  }

  const { document } = parseHTML(html);
  const head = document.querySelector("head");
  if (!head) {
    return html;
  }

  const styleEl = document.createElement("style");
  styleEl.setAttribute("data-hyperframes-deterministic-fonts", "true");
  styleEl.textContent = css;
  head.insertBefore(styleEl, head.firstChild);

  console.log(
    `[Compiler] Injected deterministic @font-face rules for ${pendingFamilies.size - unresolved.length} requested font families`,
  );
  if (unresolved.length > 0) {
    warnUnresolvedFonts(unresolved);
  }

  return document.toString();
}
