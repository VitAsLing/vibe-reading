import { defineConfig } from "wxt"

const chromeExtensionKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw2KhiXO2vySZtPu5pNSbyKhYavh8Be7gXmCZt8aJf6tQ/L3JK0qzL+3JSc/o20td3Jw+B2Dcw+EI93NAZr24xKnTNXQiJpuIuHb8xLXD0Ra/HrTVi4TJIhPdESogoG4uL6CD/F3TxfZJ2trX4Bt9cdAw1RGGeU+xU0g+YFfEka4ZUCpFAmTEw9H3/DU+nCp8yGaJWyiVgCTcFe38GZKEPt0iMJkTw956wz/iiafLx0pNG/RaztG9cAPoQOD2+SMFaeQ+b/G4OG17TYhzb09AhNBl6zSJ3jTKHSwuedCFwCce8Q/EchJfQZv71mjAE97bzwvkDYPCLj31Z5FE8HntMwIDAQAB"

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: "src",
  imports: false,
  modules: ["@wxt-dev/module-react", "@wxt-dev/i18n/module"],
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",
    // Keep extension storage stable for unpacked Chrome/Edge installs across builds.
    ...((browser === "chrome" || browser === "edge") && {
      key: chromeExtensionKey,
    }),
    permissions: [
      "storage",
      "tabs",
      "alarms",
      "scripting",
      "webNavigation",
    ],
    host_permissions: [
      "*://*/*", // Required for scripting.executeScript in any frame
    ],
    // Allow images/SVGs referenced by content-script UI <img> tags to be loaded from
    // moz-extension:// URLs on regular pages. Firefox enforces this more strictly.
    web_accessible_resources: [
      {
        resources: ["assets/*.png", "assets/*.svg", "assets/*.webp", "_locales/*/messages.json"],
        matches: ["*://*/*", "file:///*"],
      },
    ],
    // Firefox-specific settings for MV3
    ...(browser === "firefox" && {
      // Override default CSP to exclude `upgrade-insecure-requests` (Firefox MV3 default),
      // which would upgrade custom provider HTTP URLs (e.g. LAN) to HTTPS.
      content_security_policy: {
        extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
      },
      browser_specific_settings: {
        gecko: {
          id: "{bd311a81-4530-4fcc-9178-74006155461b}",
          strict_min_version: "112.0",
        },
      },
    }),
  }),
  zip: {
    excludeSources: ["docs/**/*", "assets/**/*", "repos/**/*"],
  },
  dev: {
    server: {
      // Prefer 3333 over WXT's default 3000 while still allowing WXT to pick
      // another open port when 3333 is already taken.
      port: 3333,
      strictPort: false,
    },
  },
  vite: () => ({
    plugins: [],
  }),
})
