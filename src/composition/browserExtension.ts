import { BrowserExtensionService } from "../application/browserExtension/BrowserExtensionService.js";
import { BrowserExtensionProvider } from "../browserExtension/BrowserExtensionProvider.js";

/** Portable extension inspection with no browser, store, or installation. */
export const createBrowserExtensionService = (): BrowserExtensionService =>
  new BrowserExtensionService(new BrowserExtensionProvider());
