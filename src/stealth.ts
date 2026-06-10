/**
 * Anti-bot avoidance (not bypass).
 *
 * Injects an init script into every page of a context that masks the most
 * common automation fingerprints Lazada/Akamai look at. This reduces how often
 * a challenge is triggered in the first place — it does NOT solve CAPTCHAs.
 *
 * The script runs before any page script on every navigation/iframe, so the
 * patched values are in place by the time bot-detection code reads them.
 *
 * It is shipped as a string (not a function) on purpose: this is a Node-only
 * TypeScript project with no DOM lib, so the browser globals below would not
 * type-check. The string is evaluated in the page context where they exist.
 */

import { BrowserContext } from "playwright";
import { Logger } from "./logger";

const MODULE = "stealth";

const STEALTH_INIT_SCRIPT = `
(() => {
  // navigator.webdriver — the single biggest tell for automation.
  try {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined, configurable: true });
  } catch (e) {}

  // A non-empty, plausible plugins/mimeTypes list (headless Chrome ships none).
  try {
    const fakePlugin = { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" };
    Object.defineProperty(navigator, "plugins", { get: () => [fakePlugin, fakePlugin, fakePlugin], configurable: true });
    Object.defineProperty(navigator, "mimeTypes", { get: () => [{ type: "application/pdf", suffixes: "pdf", description: "" }], configurable: true });
  } catch (e) {}

  // Consistent language set (matches the en-SG context locale).
  try {
    Object.defineProperty(navigator, "languages", { get: () => ["en-SG", "en"], configurable: true });
  } catch (e) {}

  // window.chrome — present in real Chrome, absent under automation.
  try {
    if (!window.chrome) { window.chrome = { runtime: {} }; }
  } catch (e) {}

  // Notification permission query returns "default" in real browsers rather
  // than the "denied" that headless reports.
  try {
    const original = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (parameters) =>
      parameters && parameters.name === "notifications"
        ? Promise.resolve({ state: "default" })
        : original(parameters);
  } catch (e) {}

  // WebGL vendor/renderer — headless reports a software renderer; spoof a
  // common GPU pair so it blends in.
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return "Intel Inc.";              // UNMASKED_VENDOR_WEBGL
      if (parameter === 37446) return "Intel Iris OpenGL Engine"; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, parameter);
    };
  } catch (e) {}

  // A realistic hardware profile.
  try {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8, configurable: true });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8, configurable: true });
  } catch (e) {}
})();
`;

export async function applyStealth(context: BrowserContext, logger: Logger): Promise<void> {
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  logger.info(MODULE, "stealth_init_script_applied");
}
