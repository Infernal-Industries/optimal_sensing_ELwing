// One-shot dev-server screenshot + console-error check, for verifying UI
// changes visually across phases without a GUI. Not a full REPL driver --
// each phase's check is independent enough that relaunching per-check is
// fine; revisit if iteration gets fast/frequent enough to want a REPL.
//
// Usage: node scripts/screenshot.mjs <url> <outPath> [waitMs]
import { chromium } from "playwright";

const [, , url, outPath, waitMsArg] = process.argv;
if (!url || !outPath) {
  console.error("usage: node scripts/screenshot.mjs <url> <outPath> [waitMs]");
  process.exit(1);
}
const waitMs = Number(waitMsArg || 1500);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
});

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(waitMs); // let animation/render settle
await page.screenshot({ path: outPath });
await browser.close();

console.log("screenshot:", outPath);
if (errors.length) {
  console.log("CONSOLE ERRORS:");
  errors.forEach((e) => console.log(" -", e));
  process.exit(2);
} else {
  console.log("no console errors");
}
