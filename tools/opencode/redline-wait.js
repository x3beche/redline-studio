// Workbench's queue watcher, for an agent run with OpenCode.
//
// The agent kit ships this as .opencode/plugins/redline-wait.js
// (backend/agent_kit.py). In Claude Code the main agent starts
// `revisions.py wait` in the background and ends its turn, and the command's
// exit wakes it. OpenCode's shell tool has no background mode, so this does
// the same from outside the model: whenever the main agent's session goes
// idle it runs `revisions.py wait`, and when that returns (a queued note, a
// line in the thread, an answer) it sends what wait printed into the session
// as the next message. While it waits no model is running and nothing is
// spent.
//
// The main session is the top-level one that last went idle (a room agent's
// session has a parent and is left alone). Its id is kept in
// work/.main-session so the seed can resume it after a restart: the seed
// then starts OpenCode on that session with REDLINE_OPENCODE_RESUME set to
// what to tell it, and this sends that as the first message (OpenCode's
// --prompt is not sent when a session is resumed).
// REDLINE_OPENCODE_WAIT=0 turns the watcher off.

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SETTLE_MS = 20_000          // let a just handed-off note be started first
const HANDED_MS = 10 * 60_000     // a note delivered is not delivered again this soon
const RETRY_MS = [30_000, 60_000, 120_000, 300_000, 900_000]

export const RedlineWait = async ({ client, directory }) => {
  if (process.env.REDLINE_OPENCODE_WAIT === "0") return {}
  let main = null          // the main agent's session id
  let proc = null          // the running `revisions.py wait`
  let timer = null
  let pending = null       // what wait printed while the session was busy
  let failures = 0
  const handed = new Map() // note id -> when its wait output was delivered

  const log = (level, message) =>
    client.app.log({ body: { service: "redline-wait", level, message } }).catch(() => {})

  const busy = async () => {
    try {
      const r = await client.session.status()
      const s = (r && r.data) || {}
      return !!s[main] && s[main].type !== "idle"
    } catch {
      return false
    }
  }

  const deliver = async (text, plain = false) => {
    if (!main) return
    if (await busy()) { pending = text; return }
    pending = null
    if (plain) return send({ parts: [{ type: "text", text }] }, text)
    // The notes it named: handed to a room agent now, and still "queued"
    // until that agent starts it - the next waits skip them for a while.
    for (const m of text.matchAll(/^ {2}(\S+) {2}/gm)) handed.set(m[1], Date.now())
    const body = {
      parts: [{
        type: "text",
        text: "`revisions.py wait` returned (the kit's watcher ran it while you were idle):\n\n```\n"
          + text.trim() + "\n```\n\nPick it up as AGENTS.md says - the thread first, then the queue - "
          + "and end your turn when you have handed it on: the watcher starts again by itself. "
          + "Do not run `revisions.py wait` yourself.",
      }],
    }
    return send(body, text)
  }

  const send = async (body, text) => {
    const fn = client.session.promptAsync || client.session.prompt
    try {
      await fn.call(client.session, { path: { id: main }, body })
    } catch (e) {
      pending = text
      log("warn", `could not wake the session: ${e}`)
    }
  }

  const run = () => {
    timer = null
    if (proc || !main) return
    const started = Date.now()
    let out = ""
    const skip = []
    for (const [id, at] of handed) {
      if (Date.now() - at > HANDED_MS) handed.delete(id)
      else skip.push("--ignore", id)
    }
    proc = spawn(join(directory, ".venv", "bin", "python"), ["tools/revisions.py", "wait", ...skip],
      { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
    proc.stdout.on("data", (b) => { out += b })
    proc.stderr.on("data", (b) => { out += b })
    proc.on("error", (e) => { out += String(e) })
    proc.on("close", async (code) => {
      proc = null
      if (code === 0) {
        failures = 0
        await deliver(out)
      } else if (code === 2 && Date.now() - started > 60_000) {
        later(1_000)                                     // timed out: wait again
      } else if (code !== null) {
        // The server unreachable, the token refused: try again, slower each
        // time, and say so in the session once so the person sees it.
        failures += 1
        log("warn", `revisions.py wait exited ${code}: ${out.slice(-400)}`)
        if (failures === 3) await deliver(`revisions.py wait keeps failing (exit ${code}):\n${out.slice(-1500)}`)
        later(RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)])
      }
    })
  }

  const later = (ms) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(async () => {
      if (await busy()) { timer = null; return }         // it will go idle again
      run()
    }, ms)
  }

  const resume = process.env.REDLINE_OPENCODE_RESUME
  if (resume) {
    delete process.env.REDLINE_OPENCODE_RESUME           // once, not for every instance
    let id = ""
    try { id = readFileSync(join(directory, "work", ".main-session"), "utf8").trim() } catch {}
    if (id) setTimeout(() => { main = id; deliver(resume, true) }, 4_000)
  }

  const stop = () => { if (proc) proc.kill() }
  process.on("exit", stop)
  process.on("SIGTERM", () => { stop(); process.exit(0) })

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const id = event.properties && event.properties.sessionID
      if (!id) return
      try {
        const r = await client.session.get({ path: { id } })
        if (!r || !r.data || r.data.parentID) return     // a room agent's session
      } catch {
        return
      }
      if (main !== id) {
        main = id
        try {
          mkdirSync(join(directory, "work"), { recursive: true })
          writeFileSync(join(directory, "work", ".main-session"), id + "\n")
        } catch {}
      }
      if (pending) { await deliver(pending); return }
      if (!proc && !timer) later(SETTLE_MS)
    },
  }
}
