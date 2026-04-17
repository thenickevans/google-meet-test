/**
 * Google Meet Test Utility
 *
 * One Puppeteer entry point with three rendering modes
 * (camera | camera-overlay | presentation) and two text sources
 * (typed | transcribed). Built as a test bed for the "Monster" meeting
 * recorder concept (see ~/project-and-idea-backlog/personal.md).
 *
 * Usage:
 *   node join.js <meet-url> [bot-name] [options]
 *
 * Modes — what the bot's video feed looks like:
 *   --mode camera          (default) Synthetic camera with text full-bleed on
 *                          a 1280x720 canvas. No real webcam involved.
 *   --mode camera-overlay  Real Mac webcam with a colored text overlay
 *                          (lower-third pill). Headless probably won't have
 *                          webcam access — use visible mode.
 *   --mode presentation    Bot joins as a presenter. 1920x1080 canvas via a
 *                          hooked getDisplayMedia (bypasses Chrome's screen
 *                          picker entirely). Meet auto-spotlights
 *                          presentations and never crops them.
 *
 * Sources — where the text comes from:
 *   --source typed         Live keystrokes from this terminal. (default)
 *   --source transcribed   Live speech-to-text from your mic via RealtimeSTT.
 *                          Each finalized sentence rotates through a color
 *                          palette. Requires .venv/bin/python + transcribe.py.
 *
 * Other flags:
 *   --headed      Run Chrome with a visible window. Default is headless (no
 *                 window). In headless mode a debug screenshot is saved to
 *                 /tmp/meet-bot-debug.png if auto-join fails.
 *   --login       Open Chrome to sign into Google. One-time setup; the session
 *                 cookies persist in ~/.google-meet-test-chrome-profile.
 *   --anonymous   Use a separate Chrome profile (~/.google-meet-test-chrome-
 *                 profile-anon) that isn't signed in to any Google account.
 *                 Meet shows the name-entry UI and the bot joins as `bot-name`.
 *                 In --interactive, press `a` at runtime to toggle — this
 *                 leaves the meeting, relaunches Chrome with the other profile,
 *                 and rejoins the same URL.
 *   --timing      Print a startup timing table after the bot joins. Marks
 *                 each phase (detect URL → launchChrome → newPage → install
 *                 hooks → goto → maybeMute → joinMeeting) with elapsed and
 *                 cumulative ms. Use it to see where the 1-2s startup goes.
 *   bot-name      Name shown in Meet's participant list. Only used when joining
 *                 without a Google account (i.e. --anonymous or a profile that
 *                 hasn't been signed in yet). Default: "Meet Bot".
 *
 * Examples:
 *   node join.js meet.google.com/abc-defg-hij
 *   node join.js meet.google.com/abc-defg-hij --mode presentation --source transcribed
 *   node join.js meet.google.com/abc-defg-hij --mode camera-overlay   # webcam + typed text
 *   node join.js --login
 *
 * ARCHITECTURE — read this before changing things
 * ------------------------------------------------
 * Three pipelines, one harness. Most of this file is the SHARED harness:
 * Chrome launch, anti-detection masking, the join-UI race, graceful exit,
 * the terminal input loop. Only the "install hook" step branches per mode,
 * because each mode hooks a different combination of getUserMedia /
 * getDisplayMedia and renders a different canvas.
 *
 * SHARED TEXT BUS (window.__botText + window.__segments):
 *   Whatever source is active (typed or transcribed) pushes BOTH:
 *     - window.__botText:  the plain-text version (one string)
 *     - window.__segments: an array of {text, color} for colored rendering
 *   Each mode's renderer reads whichever fits its layout. Typed source emits
 *   a single white segment; transcribed source emits one segment per
 *   finalized sentence (rotating colors) plus a pale-yellow in-progress one.
 *
 * GOTCHAS the three pipelines learned the hard way:
 *   - getDisplayMedia hook: returning a canvas.captureStream() bypasses
 *     Chrome's "Choose what to share" picker entirely. Used by presentation mode.
 *   - Camera composite: the offscreen <video> needs (a) its OWN MediaStream
 *     wrapping the original video track, separate from the stream we hand
 *     to Meet, and (b) to be attached to the DOM (off-screen). Without (a)
 *     it freezes when we swap the canvas track in; without (b) it stalls
 *     after the first frame.
 *   - setInterval, NOT requestAnimationFrame: RAF throttles to ~1fps when
 *     the Puppeteer Chrome window is backgrounded, which freezes the
 *     captureStream. setInterval keeps firing regardless of tab visibility.
 *   - Title-safe area (10% inset): Meet renders participant tiles with
 *     object-fit: cover, so anything within ~10% of any edge can get
 *     clipped on a viewer with an unusual aspect ratio. camera +
 *     camera-overlay modes inset their content. Presentation mode does NOT
 *     need this (presentations are letterboxed via object-fit: contain).
 *   - Atomic find+click: Meet re-renders aggressively (React). Element
 *     handles go stale between Puppeteer find and click. We do find+click
 *     inside one page.evaluate() to avoid stale-handle errors.
 *   - Graceful exit fallbacks: Meet's "Leave call" button isn't always a
 *     standard <button>. Four strategies + a 5s force-quit timeout
 *     guarantees we always exit cleanly.
 *   - Button rename history: the screen-share button used to be "Present
 *     now"; as of this build it's "Share screen". Defensive selectors
 *     match all known names.
 *   - Self-view mirroring: Meet always mirrors your own camera tile in the
 *     local preview. Other participants see the un-mirrored version.
 *   - Mic mute via Ctrl+D fires before Meet's keyboard handlers init —
 *     probably a no-op, but harmless. The fake device emits silence anyway.
 */

const puppeteer = require("puppeteer-core");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");

// =========================================================================
// ARGUMENT PARSING
// =========================================================================
const rawArgs = process.argv.slice(2);

function hasFlag(name) {
  return rawArgs.includes(name);
}
function getValue(name, defaultVal) {
  const i = rawArgs.indexOf(name);
  if (i === -1 || i === rawArgs.length - 1) return defaultVal;
  return rawArgs[i + 1];
}

// Known-flag validation. The old parser silently treated any unrecognized
// `--foo` as a positional arg, which meant a typo like `--timed` ended up
// as the Meet URL and blew up with a Puppeteer ProtocolError deep in
// setupSession. Catch it up front with a friendly message instead.
const KNOWN_FLAGS = new Set([
  "--headed",
  "--login",
  "--interactive",
  "--anonymous",
  "--timing",
  "--help",
  "-h",
  "--mode",
  "--source",
]);
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (a.startsWith("-")) {
    if (!KNOWN_FLAGS.has(a)) {
      console.error(`Unknown option: ${a}`);
      console.error("Run `node join.js --help` for the full flag list.");
      process.exit(1);
    }
    // Skip the value for value-flags so it isn't re-evaluated as a flag.
    if (a === "--mode" || a === "--source") i++;
  }
}

if (hasFlag("--help") || hasFlag("-h")) {
  process.stdout.write(
    `Google Meet test bot — Puppeteer-driven Meet joiner

Usage:
  node join.js [<meet-url>] [bot-name] [options]

If <meet-url> is omitted, the CLI auto-detects a Meet tab from Chrome
(via AppleScript). In --interactive it boots parked and lets you pick
or enter a URL at runtime.

Modes — the bot's outgoing video:
  --mode camera           (default) synthetic dark text canvas (1280x720)
  --mode camera-overlay   real webcam + colored lower-third text pill
  --mode presentation     bot joins as a PRESENTER (1920x1080 canvas via
                          hooked getDisplayMedia — no screen picker)

Sources — where the text comes from:
  --source typed          (default) live keystrokes from this terminal
  --source transcribed    live speech-to-text via transcribe.py (RealtimeSTT).
                          Requires .venv/bin/python and the RealtimeSTT deps.

Flags:
  --interactive   Boot parked with a hotkey legend. In interactive mode
                  you pick the mode at join time (1/2/3) and can hot-swap
                  modes, toggle auth, leave/rejoin, and change URL live.
  --headed        Run Chrome with a visible window. Default is headless.
  --anonymous     Use a separate Chrome profile that isn't signed in to
                  Google. The bot joins as <bot-name>.
  --login         One-shot Google sign-in. Opens Chrome to accounts.google.com;
                  session cookies persist in the profile dir.
  --timing        Print a per-step startup timing table after each join.
  --help, -h      Show this help and exit.

Examples:
  node join.js meet.google.com/abc-defg-hij
  node join.js meet.google.com/abc-defg-hij --mode presentation --source transcribed
  node join.js meet.google.com/abc-defg-hij --mode camera-overlay
  node join.js --interactive
  node join.js --login

Interactive hotkeys — parked (before joining a meeting):
  1 / 2 / 3   join in camera / camera-overlay / presentation mode
  c           change the Meet URL (type it in)
  Ctrl+C      quit

Interactive hotkeys — in-meeting:
  1 / 2 / 3   hot-swap to camera / camera-overlay / presentation mode
  a           toggle auth mode (signed-in ↔ anonymous) — leaves and rejoins
  l           leave the meeting and return to parked state
  ?           show the in-meeting legend
  Ctrl+C      quit
`
  );
  process.exit(0);
}

// Headless is the default now. Pass --headed to pop a visible Chrome window
// (useful for debugging the join flow, watching the canvas render, etc.).
const headless = !hasFlag("--headed");
const login = hasFlag("--login");
const interactive = hasFlag("--interactive");
const anonymous = hasFlag("--anonymous");
const timingEnabled = hasFlag("--timing");
const mode = getValue("--mode", "camera");
const source = getValue("--source", "typed");

// Startup timing harness. `--timing` collects per-step marks and prints a
// flat elapsed/cumulative table after every session build. setupSession
// resets the array at its entry so each join (initial, rejoin, auth-
// toggle) gets its own clean timing table.
const timings = [];
function mark(label) {
  if (!timingEnabled) return;
  timings.push({ label, hr: process.hrtime.bigint() });
}
function printTimings() {
  if (!timingEnabled || timings.length < 2) return;
  const start = timings[0].hr;
  const maxLabel = Math.max(4, ...timings.map((t) => t.label.length));
  const pad = (s, n) => s.padEnd(n);
  const rpad = (s, n) => s.padStart(n);
  console.log("\nStartup timing:");
  console.log(
    "  " + pad("Step", maxLabel) + "   " + rpad("Elapsed", 10) + "   " + rpad("Cumulative", 12)
  );
  for (let i = 0; i < timings.length; i++) {
    const t = timings[i];
    const cum = Number(t.hr - start) / 1e6;
    const elapsed = i === 0 ? 0 : Number(t.hr - timings[i - 1].hr) / 1e6;
    console.log(
      "  " +
        pad(t.label, maxLabel) +
        "   " +
        rpad(elapsed.toFixed(1) + " ms", 10) +
        "   " +
        rpad(cum.toFixed(1) + " ms", 12)
    );
  }
  console.log();
}

const VALID_MODES = ["camera", "camera-overlay", "presentation"];
const VALID_SOURCES = ["typed", "transcribed"];

if (!VALID_MODES.includes(mode)) {
  console.error(`Invalid --mode: ${mode}. Must be one of: ${VALID_MODES.join(", ")}`);
  process.exit(1);
}
if (!VALID_SOURCES.includes(source)) {
  console.error(`Invalid --source: ${source}. Must be one of: ${VALID_SOURCES.join(", ")}`);
  process.exit(1);
}
// Strip flags AND their values when collecting positional args
const valueFlagNames = new Set(["--mode", "--source"]);
const booleanFlagNames = new Set([
  "--headed",
  "--login",
  "--interactive",
  "--anonymous",
  "--timing",
]);
const positional = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (booleanFlagNames.has(rawArgs[i])) continue;
  if (valueFlagNames.has(rawArgs[i])) {
    i++; // skip the value too
    continue;
  }
  positional.push(rawArgs[i]);
}
let MEET_URL = positional[0];
const BOT_NAME = positional[1] || "Meet Bot";

mark("start");

// Auto-detect: if no URL was given, ask the user's real Chrome (via
// AppleScript) for any open Meet tab and use that URL. Saves the usual
// "copy URL from browser, paste into terminal" round trip. Only runs when
// positional[0] is empty — passing a URL always wins.
if (!MEET_URL && !login) {
  const detected = detectMeetUrlFromChrome();
  mark("detect URL");
  if (detected) {
    MEET_URL = detected;
    console.log(`Auto-detected Meet URL from Chrome: ${MEET_URL}`);
  } else if (!interactive) {
    // Non-interactive mode must have a URL to do anything useful, so bail
    // out with usage. Interactive mode boots parked — the user can supply
    // the URL later by opening a Meet tab in Chrome and pressing J.
    console.error(
      "Usage: node join.js <meet-url> [bot-name] [--mode camera|camera-overlay|presentation] [--source typed|transcribed] [--interactive] [--anonymous] [--headed] [--login] [--timing]"
    );
    console.error(
      "(Tip: open a Meet tab in Chrome and I'll auto-detect it — no URL argument needed.)"
    );
    process.exit(1);
  }
}

// Ask the user's real Chrome for a currently-open Meet URL. Uses the
// standard `tell application "Google Chrome" to get URL of tabs ...`
// AppleScript bridge. Returns null if Chrome isn't running, the
// AppleScript call fails, or no Meet tab is open. On first run macOS may
// prompt for "System Events"/automation permission for the terminal.
//
// KNOWN LIMITATIONS (see project_next_steps memory for the full list):
//  - Only checks Chrome. If the user has the Meet tab open in Safari,
//    Arc, Brave, Edge, or Firefox, we return null and the caller prints
//    the usage error. Generalizing to other browsers is on the backlog.
//  - If multiple Meet tabs are open across Chrome's windows, we pick the
//    first one AppleScript returns (generally leftmost in frontmost
//    window). No prompting / disambiguation yet.
//  - Regex deliberately requires the `xxx-yyyy-zzz` meeting-code format
//    so landing pages like `meet.google.com/new` or the homepage don't
//    match. If Google ever changes the code format, this breaks.
//  - `execSync` is synchronous and blocks startup for up to 3s (timeout).
//    That's the entire reason for the tight timeout — we don't want auto-
//    detect to hang the CLI on a wedged AppleScript call.
function detectMeetUrlFromChrome() {
  try {
    // Gate the AppleScript on a process check first. `tell application
    // "Google Chrome"` will LAUNCH Chrome if it isn't running, which is
    // surprising behavior for a passive "is there a Meet tab open?" probe.
    // pgrep -x matches the exact process name and exits non-zero if nothing
    // is running, which makes execSync throw and we fall through to null.
    try {
      execSync(`pgrep -x "Google Chrome"`, { stdio: "ignore", timeout: 1000 });
    } catch {
      console.log("\x1b[1;33m⚠  Chrome isn't running — skipping Meet URL auto-detect.\x1b[0m");
      return null;
    }
    const out = execSync(
      `osascript -e 'tell application "Google Chrome" to get URL of tabs of every window'`,
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
    );
    // osascript returns a single comma-separated line of URLs across all
    // tabs of all windows. Find the first one that's an actual meeting
    // (i.e. matches the xxx-yyyy-zzz code format — not the Meet home page
    // or "new meeting" landing pages).
    const meetRe = /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{3,4}-[a-z]{3}(?:[?#].*)?/i;
    for (const piece of out.split(/,\s*/)) {
      const m = piece.trim().match(meetRe);
      if (m) return m[0];
    }
    // Chrome is running but no tab matched the meeting-code regex. Tell the
    // user explicitly so they don't wonder why auto-detect "did nothing" —
    // most likely cause is they're on meet.google.com/new or the homepage
    // rather than inside an actual meeting.
    console.log(
      "\x1b[1;33m⚠  Chrome is running but no Meet tab with a meeting code was found.\x1b[0m"
    );
  } catch (e) {
    // Chrome not running, AppleScript blocked, or timeout — silently fall
    // through so the caller can print the regular usage error.
  }
  return null;
}

// =========================================================================
// CONSTANTS
// =========================================================================

// Color palette — finalized sentences cycle through these in transcribed mode.
// Bright, high-contrast colors that read well on dark backgrounds.
const SENTENCE_COLORS = [
  "#ffffff", // white
  "#7dd3fc", // sky
  "#86efac", // green
  "#fca5a5", // red
  "#fcd34d", // amber
  "#c4b5fd", // violet
  "#f9a8d4", // pink
];
// The current in-progress sentence renders in a "live" color that stands out.
const PARTIAL_COLOR = "#fef08a"; // pale yellow

const DEFAULT_TEXT = "Hello World";

// Two persistent Chrome profile dirs. The signed-in one keeps Nick's Google
// session so joinMeeting hits the "Join now" branch. The anonymous one is
// never logged in, so joinMeeting hits the "Your name" branch and the bot
// joins as BOT_NAME. Both persist across runs so Meet remembers per-site
// settings (mic/camera permissions, layout preferences, etc.).
const SIGNED_IN_PROFILE_DIR = `${os.homedir()}/.google-meet-test-chrome-profile`;
const ANONYMOUS_PROFILE_DIR = `${os.homedir()}/.google-meet-test-chrome-profile-anon`;

// =========================================================================
// MAIN
// =========================================================================
(async () => {
  printConfig();

  // Login mode is a one-shot side flow that doesn't need any other setup.
  if (login) {
    const browser = await launchChrome(anonymous);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await runLoginFlow(page, browser);
    return;
  }

  let currentAnonymous = anonymous;

  // Non-interactive mode: build the session once, run the input loop, exit.
  if (!interactive) {
    const session = await setupSession(currentAnonymous);
    printTimings();
    process.on("SIGINT", () => session.exitHandler.leave());
    await runInputLoop(session.page, session.exitHandler);
    return;
  }

  // Interactive mode. SIGINT target is held in a mutable ref that we swap
  // between the active session's exitHandler (when in a meeting) and a
  // plain process.exit (when parked, since there's no session to tear
  // down). Replacing the ref instead of re-attaching listeners avoids
  // stacking multiple SIGINT handlers over time.
  const sigintRef = { handler: { leave: () => process.exit(0) } };
  process.on("SIGINT", () => sigintRef.handler.leave());

  // Outer loop: parked ↔ active cycles. Each iteration waits in the idle
  // loop until the user picks a mode with 1/2/3, builds a session, hands
  // control to the active hotkey loop, and comes back here on park. The
  // parked legend is printed by runIdleLoop, so no separate startup
  // banner is needed here.
  while (true) {
    // --- PARKED PHASE ---
    // runIdleLoop handles the 'c' (change URL) hotkey internally and only
    // resolves once 1/2/3 is pressed. The returned mode is the entry mode
    // for the active phase.
    const idleResult = await runIdleLoop();
    let initialMode = idleResult.mode;

    console.log(`Joining ${MEET_URL} in ${initialMode} mode...`);

    // --- ACTIVE PHASE ---
    // Inner loop handles auth-toggle rebuilds WITHIN a meeting session. A
    // switch-auth signal soft-leaves, flips the profile dir, and rebuilds
    // in place, preserving the current mode across the rebuild. A park
    // signal breaks out back to the outer parked phase.
    let session = await setupSession(currentAnonymous);
    printTimings();
    sigintRef.handler = session.exitHandler;

    let parked = false;
    while (!parked) {
      // Wait for the in-call UI before accepting hotkeys, otherwise pressing
      // 3 immediately after launch would race the share-screen button.
      await session.page
        .waitForSelector('[aria-label="Leave call"]', {
          visible: true,
          timeout: 60000,
        })
        .catch(() => null);

      const { signal, lastMode } = await runHotkeyLoop(
        session.page,
        session.exitHandler,
        currentAnonymous,
        initialMode
      );

      // runHotkeyLoop resolves with a rebuild signal. Ctrl+C routes
      // through exitHandler.leave() which calls process.exit, so we never
      // fall through to an unexpected return.
      if (signal !== "switch-auth" && signal !== "park") return;

      if (signal === "switch-auth") {
        currentAnonymous = !currentAnonymous;
        console.log(
          `\nSwitching to ${currentAnonymous ? "anonymous" : "signed-in"} mode — leaving and rejoining...`
        );
        await softLeave(session.browser, session.page);
        session = await setupSession(currentAnonymous);
        printTimings();
        sigintRef.handler = session.exitHandler;
        initialMode = lastMode; // preserve the active mode across the rebuild
      } else {
        // park: soft-leave and break out to the outer parked phase.
        console.log("\nLeaving meeting...");
        await softLeave(session.browser, session.page);
        sigintRef.handler = { leave: () => process.exit(0) };
        parked = true;
      }
    }
  }
})().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

// Build one end-to-end Meet session: launch Chrome, install all hooks,
// navigate, join the call, wire up the exit handler. Returns the three
// handles callers need to drive the session.
//
// Called once in non-interactive mode, and once per auth-toggle in
// interactive mode.
async function setupSession(isAnonymous) {
  // Reset timings at the start of every build so each join (initial,
  // rejoin-from-parked, auth-toggle rebuild) prints its own clean table.
  // The module-level mark("start") from the top of the file only covers
  // the very first startup; subsequent builds re-anchor here.
  timings.length = 0;
  mark("start");
  const browser = await launchChrome(isAnonymous);
  mark("launchChrome");
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  mark("newPage");

  await installAntiDetection(page);
  mark("installAntiDetection");
  await installSharedPageState(page);
  mark("installSharedPageState");
  await installModeHook(page);
  mark("installModeHook");

  console.log(`Navigating to ${MEET_URL}...`);
  // domcontentloaded is faster than networkidle2. Meet is an SPA that loads
  // incrementally — we don't need every API call to finish, just a usable DOM.
  await page.goto(MEET_URL, { waitUntil: "domcontentloaded" });
  mark("page.goto");

  await maybeMute(page);
  mark("maybeMute");

  const joined = await joinMeeting(page);
  mark("joinMeeting");
  if (!joined) {
    await browser.close();
    process.exit(1);
  }

  // Presentation mode (non-interactive): wait until we're confirmed in the
  // meeting, then click "Share screen" so Meet calls getDisplayMedia (our
  // hook intercepts it). Interactive mode skips this — presentation only
  // fires when the user hits hotkey 3.
  if (mode === "presentation" && !interactive) {
    await page
      .waitForSelector('[aria-label="Leave call"]', {
        visible: true,
        timeout: 60000,
      })
      .catch(() => null);
    await startPresenting(page);
    mark("startPresenting");
  }

  // Exit handler is per-session: it captures this specific browser + page.
  // When we rebuild a session (anonymous toggle), the old handler is
  // retired and replaced via sigintRef in the main loop.
  const exitHandler = createExitHandler(browser, page);
  return { browser, page, exitHandler };
}

// Leave the current meeting and close the browser WITHOUT calling
// process.exit. Used by interactive mode when toggling --anonymous at
// runtime — we need to tear the current session down cleanly so we can
// relaunch Chrome under the other profile.
//
// Shorter than createExitHandler.leave() on purpose: we only try the two
// most reliable click strategies (aria-label + text search) and skip the
// "close the tab" fallback, because we're about to close the whole browser
// anyway. The browser.close() is the real teardown; the clicks just give
// Meet a chance to fire a clean "you left" signal to the host.
async function softLeave(browser, page) {
  try {
    await page
      .evaluate(() => {
        const btn = document.querySelector('[aria-label="Leave call"]');
        if (btn) btn.click();
      })
      .catch(() => {});
    await sleep(300);

    await page
      .evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim().includes("Leave call")) {
            walker.currentNode.parentElement?.click();
            return;
          }
        }
      })
      .catch(() => {});
    await sleep(200);
  } catch (e) {
    // Fine — we're about to close the browser anyway.
  }
  await browser.close().catch(() => {});
}

// =========================================================================
// CONFIG / DIAGNOSTICS
// =========================================================================
function printConfig() {
  if (login) {
    console.log(
      `Mode: login (one-time Google sign-in)${anonymous ? " [anonymous profile]" : ""}`
    );
    return;
  }
  if (interactive) {
    console.log(
      `Config: interactive (hot-swap) source=${source} anonymous=${anonymous} bot-name="${BOT_NAME}"`
    );
    return;
  }
  console.log(
    `Config: mode=${mode} source=${source} anonymous=${anonymous} headless=${headless} bot-name="${BOT_NAME}"`
  );
}

// =========================================================================
// CHROME LAUNCH
// Mode-aware: camera-overlay mode uses the REAL webcam, so it must NOT pass
// --use-fake-device-for-media-stream. Presentation mode adds tab-capture
// auto-accept flags as a safety net in case our JS hook misses.
//
// Profile-dir-aware: signed-in mode uses SIGNED_IN_PROFILE_DIR (keeps Nick's
// Google session so Meet shows "Join now"); anonymous mode uses
// ANONYMOUS_PROFILE_DIR (no Google session, so Meet shows the name input).
// =========================================================================
async function launchChrome(isAnonymous) {
  console.log(
    `Launching Chrome${headless ? " (headless)" : ""}${isAnonymous ? " [anonymous profile]" : ""}...`
  );

  const chromeArgs = [
    // Hide navigator.webdriver = true (one of the signals sites use to
    // detect automation).
    "--disable-blink-features=AutomationControlled",
    // Auto-grant camera/mic permissions (no popup).
    "--use-fake-ui-for-media-stream",
    "--window-size=1280,720",
    // Reduce headless detection surface.
    "--disable-gpu-sandbox",
    "--lang=en-US",
    "--disable-infobars",
  ];

  if (mode !== "camera-overlay" && !interactive) {
    // Synthetic camera/mic. Without our getUserMedia hook this would produce
    // Chrome's spinning green pie chart. camera-overlay AND interactive want
    // the REAL webcam (interactive needs it so it can hot-swap into the
    // camera-overlay branch on demand).
    //
    // NOTE: This works in headless too — don't gate it on `headless`. On
    // macOS, Chrome's webcam permission lives in the user data dir, so a
    // previously-authorized persistent profile (like our
    // SIGNED_IN_PROFILE_DIR) still gets real webcam access in headless mode.
    // We USED to block `--interactive --headless` on the assumption that
    // headless couldn't see a webcam — that assumption was wrong. Removed
    // the block 2026-04-11.
    chromeArgs.push("--use-fake-device-for-media-stream");
  }

  if (mode === "presentation" || interactive) {
    // Safety net in case our JS hook doesn't intercept getDisplayMedia first.
    // Auto-accepts tab capture without showing the screen picker dialog.
    chromeArgs.push("--auto-accept-this-tab-capture");
    chromeArgs.push("--enable-features=AutoAcceptThisTabCapture");
  }

  return puppeteer.launch({
    // Use the system Chrome, not bundled Chromium. Meet trusts a real Chrome
    // install more than bundled Chromium (it's the same binary the user runs).
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // headless: true uses Chrome's new headless mode with full rendering.
    // headless: "shell" is the old mode WITHOUT rendering — breaks visible:true
    // selectors since elements have no layout. Don't use "shell".
    headless: headless ? true : false,
    args: chromeArgs,
    // Persistent profile. Two dirs: a signed-in one (default) and an
    // anonymous one (--anonymous). Separate from the user's real Chrome
    // profile to avoid interference. Persists across runs so Meet remembers
    // per-site settings.
    userDataDir: isAnonymous ? ANONYMOUS_PROFILE_DIR : SIGNED_IN_PROFILE_DIR,
  });
}

// =========================================================================
// LOGIN FLOW (one-time setup)
// Opens Google sign-in. Session cookies persist in the profile dir, so
// future runs (including headless) will be signed in.
// =========================================================================
async function runLoginFlow(page, browser) {
  console.log("Opening Google sign-in...");
  console.log("Sign in with your Google account in the browser window.");
  console.log("Press 'q' here when you're done.\n");
  await page.goto("https://accounts.google.com", {
    waitUntil: "domcontentloaded",
  });

  await new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key) => {
      if (key.toString() === "q" || key.toString() === "Q" || key[0] === 3) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        resolve();
      }
    });
  });

  console.log("Login complete! Session saved. You can now run without --login.");
  await browser.close();
  process.exit(0);
}

// =========================================================================
// ANTI-DETECTION
// Spoofs the most common automation-detection signals before any page JS
// runs. Without this, Meet shows "You can't join this video call." Even
// with this, fresh/anonymous profiles may be flagged as "with potential
// risks" in the host's admit panel — that's a profile thing, not headless.
// =========================================================================
async function installAntiDetection(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  // Headless Chrome includes "Headless" in the user-agent string. Strip it.
  const browser = page.browser();
  const ua = await browser.userAgent();
  await page.setUserAgent(ua.replace(/Headless/g, ""));
}

// =========================================================================
// SHARED PAGE STATE
// Bridge variables that the Node side updates via page.evaluate, plus a
// shared wrapText helper used by every renderer. Installed before any
// mode-specific hooks so all renderers can rely on these.
// =========================================================================
async function installSharedPageState(page) {
  // Initial overlay differs by source. Typed mode shows "Hello World" as
  // a visible placeholder. Transcribed mode shows a status message that
  // matches what's actually happening RIGHT NOW: when the page first
  // loads, the bot is still in the "join the meeting" phase — the speech
  // model isn't even loading yet (that doesn't start until after we're
  // admitted and runInputLoop calls startTranscribe). The message
  // upgrades to "Loading speech-to-text..." at that moment, then clears
  // when the model is ready.
  const initialText =
    source === "transcribed" ? "Joining meeting..." : DEFAULT_TEXT;
  const initialColor = source === "transcribed" ? PARTIAL_COLOR : "#ffffff";
  await page.evaluateOnNewDocument((text, color) => {
    // Plain-text version of the current overlay. Some renderers use this
    // when they don't care about per-segment colors.
    window.__botText = text;
    // Colored segments. Each entry is {text, color}. Typed source produces
    // a single white segment; transcribed source produces one per finalized
    // sentence + a pale-yellow in-progress one at the end.
    window.__segments = [{ text, color }];

    // Shared word-wrap helper. Splits on explicit \n first, then word-wraps
    // each paragraph to fit maxWidth using the canvas context's current font.
    window.__wrapText = function (ctx, text, maxWidth) {
      const out = [];
      const paragraphs = String(text).split("\n");
      for (const para of paragraphs) {
        if (para === "") {
          out.push("");
          continue;
        }
        const words = para.split(" ");
        let currentLine = "";
        for (const word of words) {
          const testLine = currentLine ? currentLine + " " + word : word;
          if (ctx.measureText(testLine).width > maxWidth && currentLine) {
            out.push(currentLine);
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        }
        if (currentLine) out.push(currentLine);
      }
      return out;
    };

    // Shared camera-tile renderer. Used by `--mode camera` AND by the camera
    // tile in `--mode presentation` so the bot's camera tile shows the same
    // full-bleed text in both modes (presentation mode = camera mode + an
    // additional presentation surface). Single source of truth for the
    // camera-tile look.
    //
    // Assumes a 16:9 canvas (1280x720 baseline) which matches Meet's default
    // tile aspect, minimizing per-viewer cover-cropping. Title-safe inset of
    // 10% from each edge survives the worst-case crops.
    window.__drawCameraTile = function (ctx, canvas) {
      ctx.fillStyle = "#1a1a2e";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.font = "bold 56px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      const SAFE_INSET = 0.1;
      const safeX = canvas.width * SAFE_INSET;
      const safeY = canvas.height * SAFE_INSET;
      const safeW = canvas.width * (1 - SAFE_INSET * 2);
      const lineHeight = 68;

      const segments = window.__segments || [];
      let y = safeY;
      for (const seg of segments) {
        const lines = window.__wrapText(ctx, seg.text || "", safeW);
        ctx.fillStyle = seg.color || "#ffffff";
        for (const line of lines) {
          if (y + lineHeight > canvas.height - safeY) return;
          ctx.fillText(line, safeX, y);
          y += lineHeight;
        }
      }
    };

    // Shared camera-overlay renderer. Composites a real webcam frame with
    // a colored lower-third pill carrying the segment bus. Caller passes
    // the offscreen <video> element so this helper stays pure (no DOM I/O).
    // Used by `--mode camera-overlay` AND by `--interactive` mode.
    window.__drawCameraOverlay = function (ctx, canvas, video) {
      // 1. Live webcam frame as the base layer.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // 2. Lower-third pill on top.
      ctx.font = "bold 36px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      const SAFE_INSET_X = canvas.width * 0.08;
      const SAFE_INSET_Y = canvas.height * 0.1;
      const padding = 32;
      const lineHeight = 44;
      const maxWidth = canvas.width - SAFE_INSET_X * 2 - padding * 2;

      const segments = window.__segments || [];
      const renderLines = [];
      for (const seg of segments) {
        const segLines = window.__wrapText(ctx, seg.text || "", maxWidth);
        for (const ln of segLines) {
          renderLines.push({ text: ln, color: seg.color || "#ffffff" });
        }
      }

      if (renderLines.length === 0) return;

      const MAX_LINES = 6;
      const visible = renderLines.slice(-MAX_LINES);

      const blockHeight = visible.length * lineHeight + padding;
      const blockY = canvas.height - blockHeight - SAFE_INSET_Y;
      const blockX = SAFE_INSET_X;
      const blockW = canvas.width - SAFE_INSET_X * 2;

      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      const radius = 16;
      ctx.beginPath();
      ctx.moveTo(blockX + radius, blockY);
      ctx.lineTo(blockX + blockW - radius, blockY);
      ctx.quadraticCurveTo(blockX + blockW, blockY, blockX + blockW, blockY + radius);
      ctx.lineTo(blockX + blockW, blockY + blockHeight - radius);
      ctx.quadraticCurveTo(blockX + blockW, blockY + blockHeight, blockX + blockW - radius, blockY + blockHeight);
      ctx.lineTo(blockX + radius, blockY + blockHeight);
      ctx.quadraticCurveTo(blockX, blockY + blockHeight, blockX, blockY + blockHeight - radius);
      ctx.lineTo(blockX, blockY + radius);
      ctx.quadraticCurveTo(blockX, blockY, blockX + radius, blockY);
      ctx.closePath();
      ctx.fill();

      for (let i = 0; i < visible.length; i++) {
        ctx.fillStyle = visible[i].color;
        ctx.fillText(
          visible[i].text,
          blockX + padding,
          blockY + padding / 2 + i * lineHeight
        );
      }
    };

    // Shared presentation-canvas renderer. The 1920x1080 surface served via
    // hooked getDisplayMedia. Letterboxed by Meet (object-fit: contain), so
    // no title-safe inset is needed. Used by `--mode presentation` and by
    // `--interactive` mode.
    window.__drawPresentationCanvas = function (ctx, canvas) {
      // White background — looks like a slide.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Subtle border so the edges are visible against white Meet chrome.
      ctx.strokeStyle = "#e5e7eb";
      ctx.lineWidth = 4;
      ctx.strokeRect(0, 0, canvas.width, canvas.height);

      ctx.font = "bold 96px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";

      const padding = 120;
      const maxWidth = canvas.width - padding * 2;
      const lineHeight = 120;

      const segments = window.__segments || [];
      const renderLines = [];
      for (const seg of segments) {
        const segLines = window.__wrapText(ctx, seg.text || "", maxWidth);
        for (const ln of segLines) {
          renderLines.push({ text: ln, color: seg.color || "#111827" });
        }
      }

      if (renderLines.length === 0) return;

      // Vertically center the text block.
      const totalHeight = renderLines.length * lineHeight;
      const startY = (canvas.height - totalHeight) / 2;
      for (let i = 0; i < renderLines.length; i++) {
        // Use a dark color for white segments since the background is white;
        // anything explicitly colored gets used as-is.
        const color = renderLines[i].color;
        ctx.fillStyle = color === "#ffffff" ? "#111827" : color;
        ctx.fillText(renderLines[i].text, padding, startY + i * lineHeight);
      }
    };

    // Live-mode flag, only used by interactive mode's canvas dispatcher.
    // Other modes ignore it. Set/changed at runtime by the hotkey loop.
    window.__currentMode = "camera";
  }, initialText, initialColor);
}

// =========================================================================
// MODE DISPATCH — install the right combination of media hooks
// =========================================================================
async function installModeHook(page) {
  if (interactive) return installInteractiveHook(page);
  if (mode === "camera") return installCameraHook(page);
  if (mode === "camera-overlay") return installCameraOverlayHook(page);
  if (mode === "presentation") return installPresentationHook(page);
}

// -------------------------------------------------------------------------
// CAMERA MODE: synthetic camera, full-bleed text canvas
// -------------------------------------------------------------------------
async function installCameraHook(page) {
  await page.evaluateOnNewDocument(() => {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await originalGetUserMedia(constraints);
      if (!constraints.video) return stream;

      // 16:9 canvas matches Meet's tile aspect, so the default crop is zero.
      // A 4:3 canvas (like an old 640x480) was guaranteed to crop on every
      // viewer. 1280x720 is the right baseline. Drawing logic lives in
      // window.__drawCameraTile so presentation mode can reuse it.
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const ctx = canvas.getContext("2d");

      function draw() {
        window.__drawCameraTile(ctx, canvas);
      }

      // setInterval, NOT requestAnimationFrame: RAF throttles in
      // background tabs which kills captureStream.
      setInterval(draw, 33);
      draw();

      const canvasStream = canvas.captureStream(30);
      const canvasTrack = canvasStream.getVideoTracks()[0];

      // Swap the real video track for our canvas track.
      const originalTrack = stream.getVideoTracks()[0];
      if (originalTrack) {
        stream.removeTrack(originalTrack);
        originalTrack.stop();
      }
      stream.addTrack(canvasTrack);
      return stream;
    };
  });
}

// -------------------------------------------------------------------------
// CAMERA-OVERLAY MODE: real webcam composited with a colored lower-third overlay
// -------------------------------------------------------------------------
async function installCameraOverlayHook(page) {
  await page.evaluateOnNewDocument(() => {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      // Real webcam first.
      const realStream = await originalGetUserMedia(constraints);
      if (!constraints.video) return realStream;

      // CRITICAL: give the offscreen <video> its OWN MediaStream wrapping
      // just the original video track. If we set video.srcObject = realStream
      // and then later removeTrack(originalVideoTrack) (which we do below to
      // swap in the canvas), the video element loses its source and freezes
      // on the first frame. A separate wrapper stream keeps the video
      // element's source independent from what we hand to Meet.
      const originalVideoTrack = realStream.getVideoTracks()[0];
      const videoOnlyStream = new MediaStream(
        originalVideoTrack ? [originalVideoTrack] : []
      );

      // The offscreen <video> MUST be attached to the DOM. Detached video
      // elements often stall after the first frame. Off-screen + opacity 0
      // hides it from Meet's UI but keeps it decoding.
      const video = document.createElement("video");
      video.srcObject = videoOnlyStream;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.position = "fixed";
      video.style.left = "-9999px";
      video.style.top = "-9999px";
      video.style.width = "1px";
      video.style.height = "1px";
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      document.documentElement.appendChild(video);

      // Wait for the first frame so canvas dimensions are accurate.
      await new Promise((resolve) => {
        video.onloadedmetadata = () => {
          video.play().then(resolve).catch(resolve);
        };
      });

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const ctx = canvas.getContext("2d");

      function draw() {
        window.__drawCameraOverlay(ctx, canvas, video);
      }

      // setInterval not RAF — see file header for the reason.
      setInterval(draw, 33);
      draw();

      const canvasStream = canvas.captureStream(30);
      const canvasTrack = canvasStream.getVideoTracks()[0];

      // Swap the video track on the real stream so audio passes through
      // unchanged. The original video track stays alive on videoOnlyStream
      // so the offscreen <video> keeps decoding new frames.
      if (originalVideoTrack) {
        realStream.removeTrack(originalVideoTrack);
      }
      realStream.addTrack(canvasTrack);
      return realStream;
    };
  });
}

// -------------------------------------------------------------------------
// PRESENTATION MODE: small placeholder camera tile + 1920x1080 presentation
// canvas served via a hooked getDisplayMedia. The hook is the core trick.
// -------------------------------------------------------------------------
async function installPresentationHook(page) {
  await page.evaluateOnNewDocument(() => {
    // Helper: build a canvas + 30fps draw loop with a custom render fn.
    function makeCanvasStream(width, height, renderFn) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      function draw() {
        renderFn(ctx, canvas);
      }
      // setInterval not RAF (see file header).
      setInterval(draw, 33);
      draw();
      return canvas;
    }

    // ---------- CAMERA canvas ----------
    // Same 1280x720 text canvas that `--mode camera` uses, via the shared
    // window.__drawCameraTile helper. Presentation mode = camera mode + an
    // additional presentation surface, so the camera tile carries the same
    // content instead of being a placeholder.
    const cameraCanvas = makeCanvasStream(1280, 720, (ctx, canvas) => {
      window.__drawCameraTile(ctx, canvas);
    });

    // ---------- PRESENTATION canvas (1920x1080, full-resolution) ----------
    const presCanvas = makeCanvasStream(1920, 1080, (ctx, canvas) => {
      window.__drawPresentationCanvas(ctx, canvas);
    });

    // ---------- HOOK getUserMedia (camera tile) ----------
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await originalGetUserMedia(constraints);
      if (constraints.video) {
        const camStream = cameraCanvas.captureStream(30);
        const camTrack = camStream.getVideoTracks()[0];
        const orig = stream.getVideoTracks()[0];
        if (orig) {
          stream.removeTrack(orig);
          orig.stop();
        }
        stream.addTrack(camTrack);
      }
      return stream;
    };

    // ---------- HOOK getDisplayMedia (THE CORE TRICK) ----------
    // Meet calls this when the user clicks "Share screen". Our function
    // runs INSTEAD of Chrome's real implementation:
    //   - The native screen picker NEVER appears (we don't call the real API)
    //   - We return a canvas stream as if the user picked our canvas
    //   - Meet broadcasts it as a presentation: letterboxed, auto-spotlighted
    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      return presCanvas.captureStream(30);
    };
  });
}

// -------------------------------------------------------------------------
// INTERACTIVE MODE: hot-swap between all three render pipelines at runtime
// via terminal hotkeys. Sets up everything once (real webcam offscreen
// video, 1280x720 camera-tile dispatcher canvas, 1920x1080 presentation
// canvas) and the dispatcher draw function reads window.__currentMode to
// pick which renderer to use this frame. Hotkey loop in Node updates
// __currentMode by calling page.evaluate.
//
// Tradeoffs:
//  - Needs a real webcam (camera-overlay branch must be drawable any time),
//    so this mode is non-headless and fails fast if no webcam exists.
//  - Camera mode in interactive draws the dark text canvas and ignores the
//    webcam frame — the webcam keeps decoding in the background. Negligible
//    extra cost compared to standalone camera mode.
//  - Presentation toggle requires clicking Share screen / Stop sharing in
//    Meet's UI — see togglePresenting() on the Node side.
// -------------------------------------------------------------------------
async function installInteractiveHook(page) {
  await page.evaluateOnNewDocument(() => {
    // To reliably end a presentation we need to remove the track from
    // Meet's RTCRtpSender — calling track.stop() alone leaves the sender
    // attached to the peer connection, so Meet keeps the slot active.
    //
    // We collect multiple independent signals so no single detection path
    // can take the teardown down:
    //
    //   (A) allPCs[] — every RTCPeerConnection ever constructed, with its
    //       creation timestamp, so we can iterate the ones built around
    //       the time of the getDisplayMedia call.
    //   (B) postDMVideoSenders — senders that transitioned from "not
    //       carrying video" to "carrying video" within a short window
    //       after getDisplayMedia was called. This catches cases where
    //       Meet reuses an existing transceiver via replaceTrack instead
    //       of calling addTrack on a fresh PC.
    //   (C) __activePresStream — reference to the canvas stream we
    //       returned from getDisplayMedia, so we can stop its source
    //       tracks as a fallback (triggers any onended listeners).
    //
    // The hotkey loop additionally clicks Meet's "Stop presenting" button
    // at the app layer — see stopPresenting() in the Node-side helpers.
    // Without that click, Meet keeps showing a blank presentation tile
    // even after the WebRTC track is gone.
    const allPCs = [];
    const postDMVideoSenders = new Set();
    let lastGetDisplayMediaAt = 0;

    // "Right after the getDisplayMedia call" = within 10 seconds. Generous
    // to handle slow Meet setups; harmless because outside the teardown
    // call, `postDMVideoSenders` is just an ever-growing set we only read
    // from __stopInteractivePresentation.
    const RECENT_DM_MS = 10000;
    const isRecentToDM = () =>
      lastGetDisplayMediaAt > 0 &&
      Date.now() - lastGetDisplayMediaAt < RECENT_DM_MS;

    const _OrigRTCPC = window.RTCPeerConnection;
    if (_OrigRTCPC) {
      window.RTCPeerConnection = new Proxy(_OrigRTCPC, {
        construct(target, args) {
          const pc = new target(...args);
          allPCs.push({ pc, createdAt: Date.now() });

          // Hook addTrack per-PC so we can capture senders the moment
          // Meet adds a video track after the getDisplayMedia call.
          const origAddTrack = pc.addTrack.bind(pc);
          pc.addTrack = function (track, ...streams) {
            const sender = origAddTrack(track, ...streams);
            if (track && track.kind === "video" && isRecentToDM()) {
              postDMVideoSenders.add(sender);
            }
            return sender;
          };

          return pc;
        },
      });
    }

    // Hook replaceTrack so we catch the case where Meet takes an existing
    // unused transceiver and swaps a video track onto it. We only capture
    // the sender if it transitioned FROM "no video" TO "video" — this
    // avoids capturing the camera sender during normal resolution or
    // codec changes, which just swap one video track for another.
    if (window.RTCRtpSender && RTCRtpSender.prototype.replaceTrack) {
      const _OrigReplaceTrack = RTCRtpSender.prototype.replaceTrack;
      RTCRtpSender.prototype.replaceTrack = function (track) {
        const prev = this.track;
        const wasVideo = !!(prev && prev.kind === "video");
        if (
          track &&
          track.kind === "video" &&
          !wasVideo &&
          isRecentToDM()
        ) {
          postDMVideoSenders.add(this);
        }
        return _OrigReplaceTrack.call(this, track);
      };
    }

    window.__getLastGetDisplayMediaAt = () => lastGetDisplayMediaAt;
    window.__setLastGetDisplayMediaAt = (t) => {
      lastGetDisplayMediaAt = t;
    };

    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const realStream = await originalGetUserMedia(constraints);
      if (!constraints.video) return realStream;

      // Same videoOnlyStream + offscreen <video> pattern as camera-overlay
      // mode. Required so we can swap the video track on the real stream
      // without freezing the offscreen video element. See
      // feedback_camera_composite_pattern memory for the gory details.
      const originalVideoTrack = realStream.getVideoTracks()[0];
      const videoOnlyStream = new MediaStream(
        originalVideoTrack ? [originalVideoTrack] : []
      );

      const video = document.createElement("video");
      video.srcObject = videoOnlyStream;
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.style.position = "fixed";
      video.style.left = "-9999px";
      video.style.top = "-9999px";
      video.style.width = "1px";
      video.style.height = "1px";
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      document.documentElement.appendChild(video);

      await new Promise((resolve) => {
        video.onloadedmetadata = () => {
          video.play().then(resolve).catch(resolve);
        };
      });

      // Fixed 1280x720 dispatcher canvas. Webcam frames get drawImage'd
      // stretched to fit when in camera-overlay mode; aspect mismatch is
      // negligible since most Mac webcams are already 16:9 or close to it.
      const cameraCanvas = document.createElement("canvas");
      cameraCanvas.width = 1280;
      cameraCanvas.height = 720;
      const cameraCtx = cameraCanvas.getContext("2d");

      function drawCameraTile() {
        const m = window.__currentMode;
        if (m === "camera-overlay") {
          window.__drawCameraOverlay(cameraCtx, cameraCanvas, video);
        } else {
          // camera and presentation both render the dark text canvas on
          // the camera tile. Presentation mode adds the slide on top via
          // getDisplayMedia (separate canvas, separate stream).
          window.__drawCameraTile(cameraCtx, cameraCanvas);
        }
      }
      setInterval(drawCameraTile, 33);
      drawCameraTile();

      // Build the presentation canvas eagerly so getDisplayMedia can serve
      // it instantly when the user toggles to presentation mode.
      const presCanvas = document.createElement("canvas");
      presCanvas.width = 1920;
      presCanvas.height = 1080;
      const presCtx = presCanvas.getContext("2d");
      function drawPres() {
        window.__drawPresentationCanvas(presCtx, presCanvas);
      }
      setInterval(drawPres, 33);
      drawPres();

      // Stash the presentation canvas where getDisplayMedia hook can grab it.
      window.__interactivePresCanvas = presCanvas;

      // Swap the camera tile canvas in for the real webcam track. The real
      // video track stays alive on videoOnlyStream so the offscreen <video>
      // keeps decoding for camera-overlay mode.
      const canvasStream = cameraCanvas.captureStream(30);
      const canvasTrack = canvasStream.getVideoTracks()[0];
      if (originalVideoTrack) {
        realStream.removeTrack(originalVideoTrack);
      }
      realStream.addTrack(canvasTrack);
      return realStream;
    };

    // Hook getDisplayMedia to return the always-ready presentation canvas.
    // Meet only calls this when the user clicks "Share screen", which the
    // hotkey loop triggers programmatically when switching to mode 3.
    //
    // Stash the returned stream on window.__activePresStream so the hotkey
    // loop can stop the tracks when switching away from presentation mode.
    // Stopping the tracks is the *bulletproof* way to end a presentation:
    // Meet listens for `track.onended` and tears down the presentation
    // automatically (same mechanism as clicking Chrome's "Stop sharing"
    // banner). Doesn't depend on finding any Meet UI button by label.
    navigator.mediaDevices.getDisplayMedia = async function (constraints) {
      window.__setLastGetDisplayMediaAt(Date.now());
      // window.__interactivePresCanvas is set inside the getUserMedia hook,
      // which Meet always calls before the user can click Share screen.
      const c = window.__interactivePresCanvas;
      if (!c) throw new Error("Presentation canvas not initialized");
      const stream = c.captureStream(30);
      window.__activePresStream = stream;
      return stream;
    };

    window.__stopInteractivePresentation = async function () {
      const lastAt = lastGetDisplayMediaAt;
      const cutoff = lastAt - 200;

      // Race guard: if the user pressed start-then-stop very quickly,
      // Meet may not have finished setting up the share yet. We need to
      // wait until we can see SOMETHING to tear down (a captured sender
      // or a new PC with a live video sender) before proceeding —
      // otherwise we tear down nothing, Meet completes setup after we
      // return, and the share runs forever.
      //
      // Bound the wait to 4 seconds so an accidental click that never
      // produced a real share doesn't hang the hotkey loop.
      const hasSomethingToTearDown = () => {
        if (postDMVideoSenders.size > 0) return true;
        for (const { pc, createdAt } of allPCs) {
          if (createdAt < cutoff) continue;
          try {
            for (const sender of pc.getSenders()) {
              if (sender.track && sender.track.kind === "video") return true;
            }
          } catch (e) {}
        }
        return false;
      };

      const waitDeadline = Date.now() + 4000;
      while (
        lastAt > 0 &&
        !hasSomethingToTearDown() &&
        Date.now() < waitDeadline
      ) {
        await new Promise((r) => setTimeout(r, 120));
      }

      let did = false;

      // Signal (B) first: senders we actively captured via the addTrack /
      // replaceTrack hooks because they picked up a video track right
      // after getDisplayMedia. These are the highest-confidence targets.
      for (const sender of postDMVideoSenders) {
        try {
          await sender.replaceTrack(null);
          did = true;
        } catch (e) {}
      }
      postDMVideoSenders.clear();

      // Signal (A): iterate every PC constructed at or after the last
      // getDisplayMedia call (with 200ms slack for race conditions) and
      // null every video sender. The camera PC is always older than this
      // window because Meet sets up the camera PC during join, well before
      // the user clicks share-screen, so we won't touch it.
      for (const { pc, createdAt } of allPCs) {
        if (createdAt < cutoff) continue;
        let senders;
        try {
          senders = pc.getSenders();
        } catch (e) {
          continue;
        }
        for (const sender of senders) {
          if (!sender.track || sender.track.kind !== "video") continue;
          try {
            await sender.replaceTrack(null);
            did = true;
          } catch (e) {}
        }
      }

      // Signal (C): stop the source canvas tracks. Fires track.onended,
      // which some Meet code paths listen for and use to tear down the
      // presentation session automatically.
      const source = window.__activePresStream;
      if (source) {
        try {
          source.getTracks().forEach((t) => t.stop());
        } catch (e) {}
        window.__activePresStream = null;
        did = true;
      }

      return did;
    };
  });
}

// =========================================================================
// MIC MUTE (best effort)
// Fires before Meet's keyboard handlers init — probably a no-op, but
// harmless. The fake device emits silence anyway.
// =========================================================================
async function maybeMute(page) {
  try {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyD");
    await page.keyboard.up("Control");
  } catch (e) {
    // Non-critical, continue
  }
}

// =========================================================================
// JOIN FLOW
// Meet shows three different UIs depending on auth state:
//   1. NOT SIGNED IN:   Name input + "Ask to join" button
//   2. SIGNED IN:       "Join now" button (no name input)
//   3. ALREADY IN CALL: "Switch here" + "Other ways to join" → "Join here too"
// We race all three in parallel and handle whichever appears first.
//
// Returns true if the bot is in the meeting (auto or manual), false on
// hard failure.
// =========================================================================
async function joinMeeting(page) {
  console.log("Waiting for join UI...");

  // Multiple selectors per element for resilience against Meet UI changes.
  // Text-based selectors are preferred — Meet's CSS classes are obfuscated
  // and rotate on every deploy.
  const NAME_SELECTORS = [
    'input[aria-label="Your name"]',
    'input[placeholder="Your name"]',
    'input[type="text"][aria-label*="name" i]',
  ];

  const JOIN_BTN_STRATEGIES = [
    // XPath text match — most reliable.
    '::-p-xpath(//button[contains(., "Ask to join") or contains(., "Join now")])',
    // aria-label fallback.
    'button[aria-label="Ask to join"], button[aria-label="Join now"]',
    // Material Design Components data attribute fallback.
    '[data-mdc-dialog-action="join"]',
  ];

  const ALREADY_IN_CALL_STRATEGIES = [
    '::-p-xpath(//button[contains(., "Other ways to join")])',
    '::-p-xpath(//button[contains(., "Switch here")])',
  ];

  // Atomic find+click for the join button. Meet re-renders aggressively
  // (React/Lit). If we get a Puppeteer handle and then call .click(), the
  // node may detach between the two steps and throw "Node is detached".
  // Doing find+click in a single page.evaluate() avoids the round-trip.
  async function clickJoinButton(retries = 5) {
    for (let i = 0; i < retries; i++) {
      const clicked = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button")).find(
          (b) =>
            b.textContent.includes("Ask to join") ||
            b.textContent.includes("Join now")
        );
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      });
      if (clicked) return true;
      await sleep(500);
    }
    return false;
  }

  // Many Meet UI elements aren't standard <button>s — they're spans/divs
  // styled as buttons. TreeWalker over text nodes finds them by visible
  // text and clicks the parent.
  async function clickByText(text, retries = 5) {
    for (let i = 0; i < retries; i++) {
      const clicked = await page.evaluate((searchText) => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null
        );
        while (walker.nextNode()) {
          if (walker.currentNode.textContent.trim().includes(searchText)) {
            const el = walker.currentNode.parentElement;
            if (el) {
              el.click();
              return true;
            }
          }
        }
        return false;
      }, text);
      if (clicked) return true;
      await sleep(500);
    }
    return false;
  }

  // "Already in this call" → expand "Other ways to join" → "Join here too".
  async function joinWhenAlreadyInCall() {
    let clicked = await clickByText("Join here too", 1);
    if (clicked) return true;
    const expanded = await clickByText("Other ways to join", 3);
    if (!expanded) {
      console.log("Could not expand 'Other ways to join' dropdown");
      return false;
    }
    await sleep(700);
    clicked = await clickByText("Join here too", 5);
    return clicked;
  }

  // Race multiple selectors in parallel; first visible match wins.
  // Individual timeouts are swallowed so a failing selector doesn't reject
  // the whole race (the others keep trying).
  async function findWithFallbacks(selectors, timeout) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (val) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };
      for (const sel of selectors) {
        page
          .waitForSelector(sel, { visible: true, timeout })
          .then((el) => finish(el))
          .catch(() => {});
      }
      setTimeout(() => {
        if (!settled) reject(new Error("No selector matched"));
      }, timeout + 1000);
    });
  }

  // Race all three UI states in parallel.
  const firstElement = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    findWithFallbacks(NAME_SELECTORS, 15000)
      .then((el) => finish({ type: "name", el }))
      .catch(() => {});
    findWithFallbacks(JOIN_BTN_STRATEGIES, 15000)
      .then((el) => finish({ type: "join", el }))
      .catch(() => {});
    findWithFallbacks(ALREADY_IN_CALL_STRATEGIES, 15000)
      .then((el) => finish({ type: "already_in_call", el }))
      .catch(() => {});

    setTimeout(() => {
      if (!settled) reject(new Error("timeout"));
    }, 17000);
  }).catch(() => null);

  if (!firstElement) {
    // Manual fallback. In headless mode, save a debug screenshot and bail.
    if (headless) {
      const screenshotPath = "/tmp/meet-bot-debug.png";
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log("\n⚠  Could not find the join UI automatically (headless mode).");
      console.log(`   Debug screenshot saved to: ${screenshotPath}`);
      console.log("   Try again with --headed to debug.");
      return false;
    }
    console.log("\n⚠  Could not find the join UI automatically.");
    console.log("   Please click the join button in the browser window.");
    console.log("   Waiting for you to join...\n");
    const inMeeting = await page
      .waitForSelector('[aria-label="Leave call"]', {
        visible: true,
        timeout: 120000, // 2 min for manual intervention
      })
      .catch(() => null);
    if (!inMeeting) {
      console.log("Timed out waiting for manual join.");
      return false;
    }
    console.log("Joined (manual)!");
    return true;
  }

  if (firstElement.type === "name") {
    // Not signed in — fill the bot name, then click join.
    await firstElement.el.click({ clickCount: 3 });
    await firstElement.el.type(BOT_NAME);
    console.log(`Entered name: ${BOT_NAME}`);
    await findWithFallbacks(JOIN_BTN_STRATEGIES, 10000).catch(() => null);
    const clicked = await clickJoinButton();
    if (clicked) {
      console.log("Clicked join button!");
    } else {
      if (headless) {
        console.log("\n⚠  Could not find the join button (headless mode).");
        return false;
      }
      console.log("\n⚠  Could not find the join button automatically.");
      console.log("   Please click it in the browser window.\n");
      const inMeeting = await page
        .waitForSelector('[aria-label="Leave call"]', {
          visible: true,
          timeout: 120000,
        })
        .catch(() => null);
      if (!inMeeting) return false;
    }
    return true;
  }

  if (firstElement.type === "already_in_call") {
    console.log("Already in this call — joining as additional device...");
    const clicked = await joinWhenAlreadyInCall();
    if (clicked) {
      console.log("Clicked 'Join here too'!");
    } else {
      console.log("Could not click 'Join here too' — check browser window");
    }
    return true;
  }

  // Default path: signed in, "Join now" button is directly visible.
  const clicked = await clickJoinButton();
  if (clicked) {
    console.log("Clicked join button!");
  } else {
    console.log("Join button found but click failed — check browser window");
  }
  return true;
}

// =========================================================================
// PRESENTATION MODE: click "Share screen" so Meet calls getDisplayMedia
// (which our hook intercepts).
// =========================================================================
async function startPresenting(page) {
  console.log("In meeting. Starting presentation...");
  await sleep(2000); // Let the in-meeting UI settle.

  // Find the screen-share button. Meet has renamed this multiple times —
  // currently "Share screen" (aria-label), historically "Present now". Match
  // all known names plus defensive aliases. Look in BOTH aria-label and
  // data-tooltip since icon-only Meet buttons put the label in either one.
  const clicked = await page.evaluate(() => {
    const els = document.querySelectorAll(
      "button, [role='button'], [aria-label]"
    );
    for (const el of els) {
      const aria = (el.getAttribute("aria-label") || "").toLowerCase();
      const tip = (el.getAttribute("data-tooltip") || "").toLowerCase();
      const all = aria + " " + tip;
      if (
        /share\s*screen/.test(all) || // current label (2026)
        /present\s*now/.test(all) || // older label
        /start\s*presenting/.test(all) || // possible variant
        /^present$/.test(aria) // icon-only fallback
      ) {
        el.click();
        return aria || tip || "(no label)";
      }
    }
    return null;
  });

  if (!clicked) {
    console.log("⚠  Could not find the screen-share button. Click it manually in the browser.");
    console.log("   (Meet may have renamed it again — check the toolbar.)");
    return false;
  }
  console.log(`Clicked share-screen button: "${clicked}"`);
  await sleep(1500);

  // Older Meet showed a submenu (A tab / A window / Your entire screen)
  // before calling getDisplayMedia. Current Meet goes straight to the API.
  // Kept as a fallback in case Google reverts.
  const submenuOptions = [
    "A tab",
    "A Chrome tab",
    "Chrome tab",
    "A window",
    "Your entire screen",
  ];
  for (const opt of submenuOptions) {
    const ok = await page.evaluate((searchText) => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
      );
      while (walker.nextNode()) {
        if (walker.currentNode.textContent.trim().includes(searchText)) {
          const el = walker.currentNode.parentElement;
          if (el) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }, opt);
    if (ok) {
      console.log(`Clicked submenu option: "${opt}"`);
      break;
    }
  }

  // Confirm Meet's UI thinks we're presenting now.
  await sleep(2000);
  const presenting = await page.evaluate(() => {
    const text = document.body.innerText || "";
    return /you'?re presenting|stop presenting/i.test(text);
  });
  if (presenting) {
    console.log("✓ Meet confirms presentation is active");
  } else {
    console.log("⚠  Meet does not show presentation state — check the browser window");
  }
  return true;
}

// =========================================================================
// STOP PRESENTING — opposite of startPresenting. Used by interactive mode
// when the user switches OUT of presentation. Finds Meet's "Stop presenting"
// affordance (it appears in two places: a button in the toolbar, and a
// notification chip near the top) and clicks whichever exists.
// =========================================================================
async function stopPresenting(page) {
  // Try up to 3 times with short delays. Meet's "Stop presenting" affordance
  // can take a moment to mount after the WebRTC teardown disrupts the
  // stream, and the scoring/selector approach is brittle enough that a
  // single attempt has a real failure rate.
  for (let attempt = 0; attempt < 3; attempt++) {
    const clickedAny = await page.evaluate(() => {
      // Use OWN text (direct text-node children only), not textContent.
      // textContent on a parent container aggregates all descendants, so a
      // huge wrapper div can match "stop presenting" just because some
      // grandchild button has that label — and clicking the wrapper does
      // nothing. Own-text scoring finds the leaf button itself.
      const ownText = (el) => {
        let s = "";
        for (const n of el.childNodes) {
          if (n.nodeType === 3) s += n.textContent;
        }
        return s.trim().toLowerCase();
      };

      const matches = [];
      for (const el of document.querySelectorAll("*")) {
        const aria = ((el.getAttribute && el.getAttribute("aria-label")) || "").toLowerCase();
        const tip = ((el.getAttribute && el.getAttribute("data-tooltip")) || "").toLowerCase();
        const own = ownText(el);
        let score = 0;
        if (aria === "stop presenting" || aria === "stop sharing") score = 100;
        else if (own === "stop presenting" || own === "stop sharing") score = 90;
        else if (/^stop\s*(presenting|sharing|share)$/.test(aria)) score = 80;
        else if (/^stop\s*(presenting|sharing|share)$/.test(own)) score = 70;
        else if (/stop\s*present/.test(aria) || /stop\s*shar/.test(aria)) score = 50;
        else if (/stop\s*present/.test(tip) || /stop\s*shar/.test(tip)) score = 50;
        if (score > 0) matches.push({ el, score });
      }

      matches.sort((a, b) => b.score - a.score);
      if (matches.length === 0) return false;

      // Click only the single highest-scoring match. If it's not itself
      // clickable, climb up to the nearest button-like ancestor. The
      // retry loop around this call will re-score and try again if the
      // first click didn't actually end the share.
      const m = matches[0];
      let target = m.el;
      let climb = target;
      for (let i = 0; i < 5 && climb; i++) {
        if (
          climb.tagName === "BUTTON" ||
          (climb.getAttribute && climb.getAttribute("role") === "button")
        ) {
          target = climb;
          break;
        }
        climb = climb.parentElement;
      }
      try {
        target.click();
        return true;
      } catch (e) {}
      return false;
    });

    if (clickedAny) {
      await sleep(500);
      // Verify the presenting affordance is actually gone. If it is, we're
      // done. If not, loop and try again — Meet may re-render the chip.
      const stillPresenting = await page.evaluate(() => {
        for (const el of document.querySelectorAll("*")) {
          const aria = ((el.getAttribute && el.getAttribute("aria-label")) || "").toLowerCase();
          let own = "";
          for (const n of el.childNodes) {
            if (n.nodeType === 3) own += n.textContent;
          }
          own = own.trim().toLowerCase();
          if (
            aria === "stop presenting" ||
            aria === "stop sharing" ||
            own === "stop presenting" ||
            own === "stop sharing"
          ) {
            return true;
          }
        }
        return false;
      });
      if (!stillPresenting) return true;
    } else {
      await sleep(300);
    }
  }
  return false;
}

// =========================================================================
// EXIT HANDLER
// Four strategies to click Meet's leave button, then a 5s force-quit
// guarantee. Multiple strategies because Meet's leave button isn't always
// a standard <button> and the markup varies.
// =========================================================================
function createExitHandler(browser, page) {
  let leaving = false;
  let pythonProc = null;

  function setPythonProc(proc) {
    pythonProc = proc;
  }

  function leave() {
    if (leaving) return;
    leaving = true;
    console.log("\nLeaving meeting...");

    // Kill any transcription child process first.
    if (pythonProc && !pythonProc.killed) {
      try {
        pythonProc.kill("SIGTERM");
      } catch (e) {}
    }

    // Absolute guarantee: force exit after 5s no matter what.
    const forceExit = setTimeout(() => {
      console.log("Force closing...");
      try {
        if (pythonProc && !pythonProc.killed) pythonProc.kill("SIGKILL");
      } catch (e) {}
      browser.close().catch(() => {});
      process.exit(0);
    }, 5000);

    (async () => {
      try {
        // Strategy 1: aria-label selector (most common).
        await page.evaluate(() => {
          const btn = document.querySelector('[aria-label="Leave call"]');
          if (btn) {
            btn.click();
            return;
          }
        });
        await sleep(500);

        // Strategy 2: text content search via TreeWalker.
        await page.evaluate(() => {
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            null
          );
          while (walker.nextNode()) {
            if (walker.currentNode.textContent.trim().includes("Leave call")) {
              walker.currentNode.parentElement?.click();
              return;
            }
          }
        });
        await sleep(500);

        // Strategy 3: find the red hangup button by visual properties
        // (background color or material icon name).
        await page.evaluate(() => {
          const btns = document.querySelectorAll(
            'button[aria-label*="eave"], [data-tooltip*="eave"], button'
          );
          for (const btn of btns) {
            const style = window.getComputedStyle(btn);
            if (
              style.backgroundColor.includes("234") ||
              btn.innerHTML.includes("call_end") ||
              btn
                .getAttribute("aria-label")
                ?.toLowerCase()
                .includes("leave")
            ) {
              btn.click();
              return;
            }
          }
        });
        await sleep(500);

        // Strategy 4: just close the tab (triggers Meet's leave flow).
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyW");
        await page.keyboard.up("Control");
        await sleep(500);
      } catch (e) {
        // Browser may already be closed, that's fine.
      }

      clearTimeout(forceExit);
      await browser.close().catch(() => {});
      process.exit(0);
    })();
  }

  function isLeaving() {
    return leaving;
  }

  return { leave, isLeaving, setPythonProc };
}

// =========================================================================
// TRANSCRIBE: spawn .venv/bin/python transcribe.py and pipe its JSON-line
// output into the segment bus.
// =========================================================================
function startTranscribe(page, onSegmentsChanged, onReady) {
  const venvPython = path.join(__dirname, ".venv", "bin", "python");
  const script = path.join(__dirname, "transcribe.py");
  if (!fs.existsSync(venvPython)) {
    console.log("⚠  .venv/bin/python not found — cannot transcribe.");
    console.log("   Run: python3.11 -m venv .venv && .venv/bin/pip install RealtimeSTT");
    return null;
  }
  if (!fs.existsSync(script)) {
    console.log("⚠  transcribe.py not found — cannot transcribe.");
    return null;
  }

  console.log("Starting speech recognizer (model is loading)...");
  const proc = spawn(venvPython, ["-u", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // State for assembling colored segments.
  const finalSegments = []; // [{text, color}]
  let partialText = "";
  let colorIndex = 0;

  function buildSegments() {
    const segs = finalSegments.map((s) => ({ text: s.text, color: s.color }));
    if (partialText) {
      segs.push({ text: partialText, color: PARTIAL_COLOR });
    }
    return segs;
  }

  async function pushToPage() {
    const segs = buildSegments();
    const plain = segs.map((s) => s.text).join(" ");
    await page
      .evaluate(
        (s, p) => {
          window.__segments = s;
          window.__botText = p;
        },
        segs,
        plain
      )
      .catch(() => {});
    if (onSegmentsChanged) onSegmentsChanged(finalSegments, partialText);
  }

  let buffer = "";
  proc.stdout.on("data", async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // last line may be incomplete
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue; // ignore non-JSON noise
      }
      if (evt.type === "ready") {
        // Clear the placeholder when transcription kicks in.
        finalSegments.length = 0;
        partialText = "";
        await pushToPage();
        if (onReady) onReady();
      } else if (evt.type === "partial") {
        partialText = evt.text || "";
        await pushToPage();
      } else if (evt.type === "final") {
        const text = (evt.text || "").trim();
        if (text) {
          finalSegments.push({
            text,
            color: SENTENCE_COLORS[colorIndex % SENTENCE_COLORS.length],
          });
          colorIndex++;
          // Roll the buffer so it doesn't grow forever.
          if (finalSegments.length > 20) {
            finalSegments.splice(0, finalSegments.length - 20);
          }
        }
        partialText = "";
        await pushToPage();
      } else if (evt.type === "error") {
        console.log(`⚠  transcribe.py error: ${evt.message}`);
      }
    }
  });
  proc.stderr.on("data", () => {
    // Swallow Python stderr — RealtimeSTT logs a lot of warnings we don't
    // want polluting the terminal. Real errors come through the JSON 'error'
    // event on stdout.
  });
  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`⚠  transcribe.py exited with code ${code}`);
    }
  });

  // Expose state for the terminal redraw loop.
  proc.__getState = () => ({
    finalSegments: finalSegments.slice(),
    partialText,
  });
  proc.__clearState = async () => {
    finalSegments.length = 0;
    partialText = "";
    await pushToPage();
  };

  return proc;
}

// =========================================================================
// IN-MEETING INPUT LOOP
// Typed source: handles keystrokes; pushes typed text to the segment bus.
// Transcribed source: spawns transcribe.py; ignores typed input except
// Ctrl+C (leave) and Escape (clear transcript).
// =========================================================================
async function runInputLoop(page, exitHandler) {
  let pythonProc = null;
  let displayText = DEFAULT_TEXT;
  let speechReady = false;
  // First redraw skips the screen-clear so anything printed during startup
  // (config, auto-detect line, --timing table) stays visible in scrollback.
  // Once the user starts typing / transcribing, subsequent redraws clear as
  // normal to maintain a stable input frame.
  let firstDraw = true;

  // ----- Typed source: push the current text as a single white segment.
  async function pushTypedText() {
    const segs = displayText
      ? [{ text: displayText, color: "#ffffff" }]
      : [];
    await page
      .evaluate(
        (s, t) => {
          window.__segments = s;
          window.__botText = t;
        },
        segs,
        displayText
      )
      .catch(() => {});
  }

  // ----- Terminal redraw — different layouts for typed vs transcribed.
  function redrawTerminal() {
    if (firstDraw) {
      firstDraw = false;
      process.stdout.write("\n");
    } else {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    process.stdout.write(
      `Mode: ${mode}  |  Source: ${source}  |  ${MEET_URL}\n`
    );
    if (source === "typed") {
      process.stdout.write(
        "Type to update the overlay. Enter = newline | Esc = clear | Ctrl+C = leave\n"
      );
      process.stdout.write("─".repeat(72) + "\n");
      process.stdout.write(displayText);
    } else {
      process.stdout.write(
        "🎤 Live transcript. Esc = clear | Ctrl+C = leave\n"
      );
      process.stdout.write("─".repeat(72) + "\n");
      if (!speechReady) {
        process.stdout.write("(speech model still loading...)\n");
        return;
      }
      const state = pythonProc?.__getState?.() || {
        finalSegments: [],
        partialText: "",
      };
      for (const seg of state.finalSegments.slice(-8)) {
        process.stdout.write(seg.text + "\n");
      }
      if (state.partialText) {
        process.stdout.write("… " + state.partialText + "\n");
      }
    }
  }

  // ----- Source setup -----
  if (source === "transcribed") {
    // Upgrade the placeholder from "Joining meeting..." to a more accurate
    // "Loading speech-to-text..." now that we're actually about to spawn
    // the Python recognizer and load the Whisper model. The 'ready'
    // handler inside startTranscribe will clear this once the model is up.
    await page
      .evaluate((color) => {
        window.__segments = [
          { text: "Loading speech-to-text...", color },
        ];
        window.__botText = "Loading speech-to-text...";
      }, PARTIAL_COLOR)
      .catch(() => {});

    pythonProc = startTranscribe(
      page,
      () => redrawTerminal(), // segments changed → mirror in terminal
      () => {
        speechReady = true;
        redrawTerminal();
      }
    );
    if (pythonProc) {
      exitHandler.setPythonProc(pythonProc);
    } else {
      // Transcription couldn't start. Fall back to typed so the bot still works.
      console.log("Falling back to typed source.");
      await sleep(1500);
    }
  }

  // Push the initial overlay so something appears even before the user types.
  if (source === "typed" || !pythonProc) {
    await pushTypedText();
  }

  redrawTerminal();

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", async (key) => {
    if (exitHandler.isLeaving()) return;

    // Ctrl+C — leave (works in any source mode).
    if (key[0] === 3) {
      process.stdout.write("\n");
      exitHandler.leave();
      return;
    }

    // Escape — clear (works in any source mode).
    if (key[0] === 27 && key.length === 1) {
      if (source === "transcribed" && pythonProc) {
        await pythonProc.__clearState?.();
        redrawTerminal();
      } else {
        displayText = "";
        await pushTypedText();
        redrawTerminal();
      }
      return;
    }

    // In transcribed mode, ignore typed characters — the canvas is driven
    // by speech. (Ctrl+C and Escape above still work.)
    if (source === "transcribed" && pythonProc) return;

    // Enter — newline.
    if (key[0] === 13) {
      displayText += "\n";
      await pushTypedText();
      redrawTerminal();
      return;
    }

    // Backspace (127) or Delete (8).
    if (key[0] === 127 || key[0] === 8) {
      if (displayText.length > 0) {
        displayText = displayText.slice(0, -1);
      }
      await pushTypedText();
      redrawTerminal();
      return;
    }

    // Printable characters.
    const ch = key.toString();
    if (ch && !ch.match(/[\x00-\x1f]/)) {
      displayText += ch;
      await pushTypedText();
      redrawTerminal();
    }
  });
}

// =========================================================================
// IN-MEETING HOTKEY LOOP (interactive mode)
// One key = one action. Hot-swaps render modes by writing to
// window.__currentMode and updating the segment bus to a label that
// identifies which mode you're looking at. Toggling to/from presentation
// also drives Meet's Share screen / Stop sharing buttons so the
// presentation surface actually appears for other participants.
//
// Returns a promise that resolves with "switch-auth" when the user presses
// 'a' to toggle anonymous/signed-in mode. The caller is expected to tear
// down this session and rebuild a new one. All other exit paths ('l',
// Ctrl+C) call exitHandler.leave() which terminates the process, so in
// practice this promise either resolves with "switch-auth" or never
// resolves at all.
// =========================================================================
async function runHotkeyLoop(page, exitHandler, isAnonymous, initialMode) {
  // Track presentation state on the Node side because Meet's UI is the
  // source of truth for whether we're sharing — we drive that via clicks.
  let isPresenting = false;
  // Current logical mode the user picked. Mirrored into window.__currentMode.
  // Seeded from initialMode — in interactive mode, the parked idle loop
  // picks this via the 1/2/3 hotkeys; after an auth-toggle rebuild, the
  // main loop passes the pre-rebuild mode here to preserve it.
  let currentMode = initialMode || "camera";

  const MODE_LABELS = {
    camera: "Camera Mode",
    "camera-overlay": "Camera Overlay Mode",
    presentation: "Presentation Mode",
  };

  function legend() {
    return [
      "Interactive mode — hot-swap render pipelines with one key.",
      "  1   camera        (synthetic dark text canvas)",
      "  2   camera-overlay (real webcam + lower-third pill)",
      "  3   presentation  (text canvas + 1920x1080 slide via screen share)",
      `  a   toggle auth mode (currently: ${isAnonymous ? "anonymous" : "signed in"}) — leaves and rejoins`,
      "  l   leave the meeting (stay parked — press j to rejoin)",
      "  ?   show this legend",
      "  Ctrl+C   quit the CLI",
    ].join("\n");
  }

  // Print the legend once at startup. Each subsequent mode change writes a
  // single status line without clearing — keeps the scrollback intact so
  // you can see the history of what you pressed.
  function printLegendOnce() {
    process.stdout.write(
      `Interactive  |  ${MEET_URL}  |  auth: ${isAnonymous ? "anonymous" : "signed in"}\n`
    );
    process.stdout.write(legend() + "\n");
    process.stdout.write("─".repeat(72) + "\n");
  }

  function printStatus() {
    process.stdout.write(
      `→ Current: ${MODE_LABELS[currentMode]}` +
        (currentMode === "presentation"
          ? isPresenting
            ? "  (sharing)"
            : "  (NOT sharing — toggle failed?)"
          : "") +
        "\n"
    );
  }

  // Push the mode label into the segment bus so the canvas shows it. Color
  // is white in camera/camera-overlay (dark bg) and gets remapped to dark in
  // the presentation canvas helper.
  async function setSegmentsToLabel(label) {
    await page
      .evaluate(
        (text) => {
          window.__segments = [{ text, color: "#ffffff" }];
          window.__botText = text;
        },
        label
      )
      .catch(() => {});
  }

  async function setCurrentMode(next) {
    currentMode = next;
    await page
      .evaluate((m) => {
        window.__currentMode = m;
      }, next)
      .catch(() => {});
    await setSegmentsToLabel(MODE_LABELS[next]);
  }

  // Initial state: set the label for the chosen mode. If the caller chose
  // presentation as the entry mode, kick off the Share-screen click here
  // so the bot lands in the meeting already presenting. Camera and
  // camera-overlay need no additional setup — installModeHook already
  // wired getUserMedia / getDisplayMedia at session-build time.
  await setCurrentMode(currentMode);
  if (currentMode === "presentation") {
    const ok = await startPresenting(page);
    isPresenting = !!ok;
  }
  printLegendOnce();
  printStatus();

  // Serialize hotkey handling. Without this, rapid keypresses can
  // interleave: e.g. pressing "3" then "1" quickly starts a handler that
  // clicks share-screen and another that tries to tear down, and they
  // race through the shared presentation state.
  let transitioning = false;

  // Wrap the listener in a promise so the caller can await a rebuild signal
  // ("switch-auth" = rebuild under the other profile, "park" = tear down
  // and drop into the idle loop) without us ever actually returning from
  // the function. Ctrl+C paths through exitHandler.leave() instead, which
  // terminates the whole process and never resolves this promise.
  return new Promise((resolve) => {
    // Shared cleanup for any hotkey that wants the main loop to tear this
    // session down (auth toggle, park). Stops any in-progress presentation
    // so the soft-leave doesn't leave a dead share behind, detaches the
    // stdin listener, and resolves with the caller-chosen signal. The main
    // loop dispatches on the signal string.
    const exitLoopWith = async (signal) => {
      if (transitioning) return;
      transitioning = true;
      if (currentMode === "presentation" && isPresenting) {
        await page
          .evaluate(() => {
            return (
              typeof window.__stopInteractivePresentation === "function" &&
              window.__stopInteractivePresentation()
            );
          })
          .catch(() => false);
        await sleep(250);
        await stopPresenting(page).catch(() => false);
        isPresenting = false;
      }
      // transitioning stays true — we're exiting this loop for good.
      process.stdin.removeListener("data", handleKey);
      // Drop raw mode so the next session (or a post-exit shell) doesn't
      // inherit our terminal settings. The next runHotkeyLoop will flip
      // it back on when it takes over.
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      // Return the current mode too so the main loop can preserve it
      // across an auth-toggle rebuild (for park, the next join will pick
      // its own mode via the idle loop so lastMode is unused).
      resolve({ signal, lastMode: currentMode });
    };

    const handleKey = async (key) => {
      if (exitHandler.isLeaving()) return;

      // Ctrl+C — leave.
      if (key[0] === 3) {
        process.stdout.write("\n");
        exitHandler.leave();
        return;
      }

      const ch = key.toString();

      if (ch === "1" || ch === "2" || ch === "3") {
        if (transitioning) return; // drop keystrokes during a transition
        transitioning = true;
        // Per-switch phase timings. Only populated when --timing is on; the
        // helper short-circuits otherwise so there's no overhead in the
        // default path. Printed below printStatus() as one compact line.
        const phases = [];
        const timePhase = async (label, fn) => {
          if (!timingEnabled) return fn();
          const t0 = process.hrtime.bigint();
          const result = await fn();
          phases.push({
            label,
            ms: Number(process.hrtime.bigint() - t0) / 1e6,
          });
          return result;
        };
        try {
          const next =
            ch === "1"
              ? "camera"
              : ch === "2"
                ? "camera-overlay"
                : "presentation";

          // If switching AWAY from presentation, end the presentation. We do
          // it in two layers because neither alone has been reliable:
          //   1. WebRTC teardown — null the screen-share sender's track and
          //      stop the canvas source tracks. The page-side helper polls
          //      up to 4s for Meet to actually establish the share before
          //      tearing down, which protects against the start-then-stop-
          //      quickly race.
          //   2. UI click — click Meet's "Stop presenting" affordance.
          //      Without this, Meet's UI state machine still considers
          //      itself presenting and the blank tile hangs around.
          // See feedback_stop_presenting_pattern memory for the rationale.
          if (
            currentMode === "presentation" &&
            next !== "presentation" &&
            isPresenting
          ) {
            await timePhase("stop present", async () => {
              await page
                .evaluate(() => {
                  return (
                    typeof window.__stopInteractivePresentation === "function" &&
                    window.__stopInteractivePresentation()
                  );
                })
                .catch(() => false);
              // Small pause so Meet notices the track is gone and renders
              // the "Stop presenting" affordance stably before the click.
              await sleep(250);
              await stopPresenting(page).catch(() => false);
              isPresenting = false;
            });
          }

          await timePhase("set mode", () => setCurrentMode(next));

          // If switching TO presentation, click Share screen so Meet calls
          // getDisplayMedia (our hook returns the presentation canvas).
          if (next === "presentation" && !isPresenting) {
            await timePhase("start present", async () => {
              const ok = await startPresenting(page);
              isPresenting = !!ok;
            });
          }

          printStatus();
          if (timingEnabled && phases.length) {
            const total = phases.reduce((s, p) => s + p.ms, 0);
            const parts = phases
              .map((p) => `${p.label} ${p.ms.toFixed(0)} ms`)
              .join(" → ");
            process.stdout.write(
              `   timing: ${parts}  (total ${total.toFixed(0)} ms)\n`
            );
          }
        } finally {
          transitioning = false;
        }
        return;
      }

      if (ch === "a" || ch === "A") {
        // Toggle auth mode. Requires tearing down the current Chrome session
        // and relaunching under the other profile dir, then rejoining the
        // same Meet URL. The main loop handles the rebuild.
        await exitLoopWith("switch-auth");
        return;
      }

      if (ch === "l" || ch === "L") {
        // Leave the current meeting but KEEP the CLI alive. Main loop enters
        // an idle state where 'j' / 'J' can rebuild a session and rejoin.
        // Full exit is Ctrl+C — `l` no longer quits the whole process in
        // interactive mode.
        await exitLoopWith("park");
        return;
      }

      if (ch === "?" || ch === "h" || ch === "H") {
        printLegendOnce();
        printStatus();
        return;
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handleKey);
  });
}

// =========================================================================
// IDLE (PARKED) LOOP
// Runs in interactive mode before the first meeting AND after every 'l'
// leave. No Chrome session is active while we're here. Hotkeys:
//   1 / 2 / 3  → join the current MEET_URL in camera / overlay /
//                presentation mode (resolves with {mode})
//   c          → prompt for a new URL (line-mode readline, then stay parked)
//   Ctrl+C     → quit (no session to soft-leave)
// =========================================================================
async function runIdleLoop() {
  function printParkedPrompt() {
    const urlLine = MEET_URL
      ? `URL: ${MEET_URL}`
      : `URL: (not set — press c to set one)`;
    const lines = [
      "",
      `Parked  |  ${urlLine}`,
      "  1   join in camera mode         (synthetic dark text canvas)",
      "  2   join in camera-overlay mode (real webcam + lower-third pill)",
      "  3   join in presentation mode   (text canvas + 1920x1080 slide)",
      "  c   change the Meet URL (type it in)",
      "  Ctrl+C   quit",
      "─".repeat(72),
    ];
    process.stdout.write(lines.join("\n") + "\n");
  }

  printParkedPrompt();

  return new Promise((resolve) => {
    const handleKey = (key) => {
      // Ctrl+C — nothing to leave, just quit.
      if (key[0] === 3) {
        process.stdin.removeListener("data", handleKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        process.exit(0);
      }

      const ch = key.toString();

      if (ch === "1" || ch === "2" || ch === "3") {
        if (!MEET_URL) {
          process.stdout.write(
            "No URL set — press c to set one first.\n"
          );
          return;
        }
        const mode =
          ch === "1"
            ? "camera"
            : ch === "2"
              ? "camera-overlay"
              : "presentation";
        process.stdin.removeListener("data", handleKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve({ mode });
        return;
      }

      if (ch === "c" || ch === "C") {
        // Temporarily detach the raw-mode key listener so readline can read
        // a full line. We reinstall it after the question resolves. During
        // the prompt window, the process-level SIGINT handler is still
        // set to plain process.exit (we're parked), so Ctrl+C during typing
        // quits cleanly.
        process.stdin.removeListener("data", handleKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        rl.question("Enter Meet URL: ", (answer) => {
          rl.close();
          const trimmed = answer.trim();
          if (trimmed) {
            MEET_URL = trimmed;
            process.stdout.write(`URL set to ${MEET_URL}\n`);
          } else {
            process.stdout.write("(unchanged)\n");
          }
          // Reinstall raw-mode listener and reprint the parked prompt so
          // the user sees the refreshed URL in the hotkey legend.
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on("data", handleKey);
          printParkedPrompt();
        });
        return;
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", handleKey);
  });
}

// =========================================================================
// UTIL
// =========================================================================
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
