import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { chromium } from "playwright"

// A fresh browser is attached without Playwright's focus overrides. Changing
// those overrides through another CDP session cannot disable the first session.
export async function launchNativeVisibilityBrowser({ executablePath, extensionPath }) {
  const profile = await mkdtemp(path.join(os.tmpdir(), "vibe-reading-native-e2e-"))
  const child = spawn(executablePath ?? chromium.executablePath(), [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
    "--no-first-run", "--no-default-browser-check", "--no-sandbox",
    "--password-store=basic", "--use-mock-keychain",
    "--headless=new",
    `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "about:blank",
  ], { stdio: "ignore" })
  const state = { exited: false, spawnError: undefined }
  child.on("close", () => {
    state.exited = true
  })
  child.on("error", (error) => {
    state.spawnError = error
  })
  const signalHandlers = new Map()
  let closing
  const close = () => {
    closing ??= (async () => {
      for (const [signal, timeout] of [["SIGTERM", 5000], ["SIGKILL", 2000]]) {
        if (state.exited)
          break
        child.kill(signal)
        const deadline = Date.now() + timeout
        while (!state.exited && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 50))
      }
      for (const [signal, handler] of signalHandlers)
        process.off(signal, handler)
      if (!state.exited)
        throw new Error("Native acceptance browser did not exit; its disposable profile is retained")
      await rm(profile, { recursive: true, force: true })
    })()
    return closing
  }
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    const handler = () => void close().then(() => process.exit(code), () => process.exit(1))
    signalHandlers.set(signal, handler)
    process.on(signal, handler)
  }
  try {
    const deadline = Date.now() + 15000
    let endpoint
    while (Date.now() < deadline) {
      if (state.spawnError)
        throw state.spawnError
      if (state.exited)
        throw new Error("Native acceptance browser exited before CDP became available")
      try {
        const [port, target] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n")
        if (port && target) {
          endpoint = `http://127.0.0.1:${port}`
          break
        }
      }
      catch (error) {
        if (error.code !== "ENOENT")
          throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!endpoint)
      throw new Error("Native acceptance browser did not publish its CDP endpoint")
    const browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true })
    return { context: browser.contexts()[0], close, endpoint }
  }
  catch (error) {
    await close()
    throw error
  }
}
