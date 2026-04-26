import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger.js";
import { withExponentialBackoff } from "../utils/retry.js";

const MODEL = "claude-sonnet-4-6";

const SYSTEM = `You are an expert web developer. Given a description, generate a complete, beautiful, production-ready single-file HTML website.

REQUIREMENTS:
- Return ONLY raw HTML — no markdown, no code fences, no explanation
- Everything must be in a single HTML file: HTML + CSS + JavaScript all inline
- The page must listen on the PORT environment variable (default 3000) — BUT since this is static HTML, just make it a complete static page
- Include a /health endpoint response — since this is static HTML served by a Node.js wrapper, the wrapper handles /health
- Make it visually stunning: use Google Fonts, CSS animations, gradients, modern layout
- Make it fully responsive (mobile-first)
- Use semantic HTML5
- The design should match the described purpose — be creative and intentional
- Include relevant placeholder content that fits the user's description
- NO external JavaScript libraries (keep it pure CSS/HTML/vanilla JS)
- DO NOT include any tracking scripts, ads, or external images that might fail

OUTPUT: A complete HTML document starting with <!DOCTYPE html>`;

function extractHtml(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("```html")) {
    return trimmed.replace(/^```html\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  if (lower.startsWith("```")) {
    return trimmed.replace(/^```\w*\s*/i, "").replace(/```\s*$/i, "").trim();
  }
  return trimmed;
}

export async function generateWebsite(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is required");

  const client = new Anthropic({ apiKey });

  const text = await withExponentialBackoff(
    async () => {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 16_384,
        system: SYSTEM,
        messages: [{ role: "user", content: prompt }],
      });
      const final = await stream.finalMessage();
      let acc = "";
      for (const block of final.content) {
        if (block.type === "text") acc += block.text;
      }
      return acc;
    },
    { maxAttempts: 3, initialDelayMs: 2000, label: "claude" },
  );

  const html = extractHtml(text);
  if (!html.toLowerCase().includes("<!doctype html")) {
    logger.warn("Claude output missing doctype; wrapping as-is");
  }
  return html;
}
