/**
 * Google Meet Bot — Test Utility
 *
 * A Puppeteer-based bot that joins Google Meet calls. Built as a test bed for
 * a meeting recorder concept (see ~/project-and-idea-backlog/personal.md).
 *
 * What this does:
 *   - Launches a real Chrome instance (not bundled Chromium) via puppeteer-core
 *   - Navigates to a Google Meet URL and automatically joins the call
 *   - Injects a custom canvas as the bot's camera feed (currently "Hello World")
 *   - Supports headless mode for running without a visible browser window
 *
 * Usage:
 *   node join.js <meet-url> [bot-name] [--headless] [--login]
 *
 *   --login     Open Chrome to sign into Google. One-time setup — session cookies
 *               persist in ~/.google-meet-test-chrome-profile across runs.
 *   --headless  Run without a visible browser window. If auto-join fails in
 *               headless mode, a debug screenshot is saved to /tmp/meet-bot-debug.png.
 *   bot-name    Name shown in Meet's participant list (default: "Meet Bot").
 *               Only used when joining without a Google account.
 *
 * Architecture notes:
 *   - Uses puppeteer-core (not puppeteer) so it uses the local Chrome install
 *     rather than downloading a separate Chromium. This matters because Meet
 *     trusts a real Chrome install more than bundled Chromium.
 *   - The Chrome profile lives at ~/.google-meet-test-chrome-profile (survives
 *     reboots, unlike /tmp). Google sessions last weeks-to-months before
 *     requiring re-auth.
 *   - Camera feed is injected by hooking navigator.mediaDevices.getUserMedia
 *     via evaluateOnNewDocument (runs before Meet's JS loads). The hook replaces
 *     the video track with a canvas stream. This is the slot where a recorder would
 *     render live transcripts, notes, etc.
 *
 * Known brittleness / things that can break:
 *   - Google Meet has no bot API. Everything here is browser automation against
 *     a UI that Google can change at any time. Selectors are text-based (not
 *     class-based) because Meet's CSS classes are obfuscated and change on
 *     every deploy. Text like "Ask to join" and "Join now" is more stable.
 *   - Meet re-renders aggressively (React/Lit). Puppeteer element handles can
 *     go stale between find and click. That's why clickJoinButton() does
 *     find+click atomically inside page.evaluate() instead of using handles.
 *   - The "already in call" flow (Join here too) uses clickByText() with a
 *     TreeWalker because those UI elements aren't standard <button> tags —
 *     they're spans/divs that Meet makes clickable.
 *   - Headless mode requires anti-detection measures (webdriver flag, user-agent
 *     stripping, fake plugins). Without these, Meet shows "You can't join this
 *     video call." Even with them, Meet may flag the bot as "with potential risks"
 *     in the host's admit panel — this seems to be about the anonymous/fresh
 *     profile rather than headless detection specifically.
 *   - The mic mute via Ctrl+D fires right after domcontentloaded, which is
 *     before Meet's keyboard handlers initialize. It probably does nothing.
 *     Non-critical since the fake device stream produces silence anyway.
 */

const puppeteer = require("puppeteer-core");

// --- Argument parsing ---
const args = process.argv.slice(2);
const headless = args.includes("--headless");
const login = args.includes("--login");
const flagArgs = ["--headless", "--login"];
const positionalArgs = args.filter((a) => !flagArgs.includes(a));
const MEET_URL = positionalArgs[0];
const BOT_NAME = positionalArgs[1] || "Meet Bot";

if (!MEET_URL && !login) {
  console.error("Usage: node join.js <meet-url> [bot-name] [--headless] [--login]");
  process.exit(1);
}

(async () => {
  console.log(`Launching Chrome${headless ? " (headless)" : ""}...`);
  const browser = await puppeteer.launch({
    // Use the system Chrome, not a bundled Chromium. Meet is more likely to
    // trust a real Chrome install (same binary the user runs day-to-day).
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    // headless: true uses Chrome's new headless mode with full rendering.
    // headless: "shell" is the old mode WITHOUT rendering — breaks visible:true
    // selectors since elements have no layout. Don't use "shell".
    headless: headless ? true : false,
    args: [
      // Prevents Chrome from exposing navigator.webdriver = true, which is
      // one of the signals sites use to detect automation.
      "--disable-blink-features=AutomationControlled",
      // Auto-grant camera/mic permissions (no popup).
      "--use-fake-ui-for-media-stream",
      // Use a synthetic camera/mic device so no real hardware is needed.
      // Without our getUserMedia hook, this produces a spinning green pie chart.
      // With the hook, our canvas replaces it.
      "--use-fake-device-for-media-stream",
      "--window-size=1280,720",
      // Additional flags to reduce headless detection surface.
      "--disable-gpu-sandbox",
      "--lang=en-US",
      "--disable-infobars",
    ],
    // Persistent profile directory. Keeps Google login session across runs.
    // Separate from the user's real Chrome profile to avoid interference.
    // Previously was in /tmp (cleared on reboot) — moved here for persistence.
    userDataDir: `${require("os").homedir()}/.google-meet-test-chrome-profile`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });

  // =========================================================================
  // LOGIN MODE
  // One-time setup: opens Google sign-in so the user can authenticate.
  // After this, session cookies persist in the profile directory and future
  // runs (including headless) will be signed in.
  // =========================================================================
  if (login) {
    console.log("Opening Google sign-in...");
    console.log("Sign in with your Google account in the browser window.");
    console.log("Press 'q' here when you're done.\n");
    await page.goto("https://accounts.google.com", {
      waitUntil: "domcontentloaded",
    });

    // Block until user signals they're done signing in
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
  // Google Meet blocks or flags headless Chrome. These overrides mask the most
  // common detection signals. evaluateOnNewDocument runs before any page JS,
  // so Meet's detection scripts see the spoofed values.
  // =========================================================================
  await page.evaluateOnNewDocument(() => {
    // navigator.webdriver is true in automated Chrome — sites check this.
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    // Headless Chrome has an empty plugins array; real Chrome has several.
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });
    // Ensure language list looks normal.
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });
  });

  // Chrome's headless mode includes "Headless" in the user-agent string.
  // Strip it so the UA looks like a normal browser.
  const ua = await browser.userAgent();
  await page.setUserAgent(ua.replace(/Headless/g, ""));

  // =========================================================================
  // CUSTOM CAMERA FEED
  // This is the core concept: the bot's video feed is a canvas
  // we control, not a real webcam. Currently renders "Hello World" but this is
  // where you'd render live transcripts, AI notes, etc.
  //
  // How it works:
  //   1. evaluateOnNewDocument hooks getUserMedia BEFORE Meet's JS loads
  //   2. When Meet requests camera access, our hook intercepts the stream
  //   3. We create an offscreen canvas, draw on it, and call captureStream(30)
  //      to get a 30fps MediaStream from the canvas
  //   4. We swap the real video track for our canvas track on the stream
  //   5. Meet receives our canvas as "the camera" and broadcasts it to the call
  //
  // Note: the canvas text appears mirrored in Meet's self-view preview (Meet
  // mirrors your own camera). Other participants see it correctly.
  // =========================================================================
  await page.evaluateOnNewDocument(() => {
    const originalGetUserMedia =
      navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

    navigator.mediaDevices.getUserMedia = async function (constraints) {
      const stream = await originalGetUserMedia(constraints);

      if (constraints.video) {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 480;
        const ctx = canvas.getContext("2d");

        function draw() {
          ctx.fillStyle = "#1a1a2e";
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          ctx.fillStyle = "#ffffff";
          ctx.font = "bold 48px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("Hello World", canvas.width / 2, canvas.height / 2);

          requestAnimationFrame(draw);
        }
        draw();

        const canvasStream = canvas.captureStream(30);
        const canvasTrack = canvasStream.getVideoTracks()[0];

        // Swap the real video track for our canvas track
        const originalTrack = stream.getVideoTracks()[0];
        if (originalTrack) {
          stream.removeTrack(originalTrack);
          originalTrack.stop();
        }
        stream.addTrack(canvasTrack);
      }

      return stream;
    };
  });

  // =========================================================================
  // NAVIGATE TO MEETING
  // =========================================================================
  console.log(`Navigating to ${MEET_URL}...`);
  // domcontentloaded is faster than networkidle2. Meet is an SPA that loads
  // incrementally — we don't need to wait for every API call to finish, just
  // for the DOM to be ready enough to find our target elements.
  await page.goto(MEET_URL, { waitUntil: "domcontentloaded" });

  // Attempt to mute mic via keyboard shortcut. This fires before Meet's
  // keyboard handlers are initialized so it likely does nothing, but it's
  // harmless. The fake device stream produces silence anyway.
  try {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyD");
    await page.keyboard.up("Control");
  } catch (e) {
    // Non-critical, continue
  }

  // =========================================================================
  // JOIN FLOW
  //
  // Google Meet shows different UIs depending on auth state:
  //   1. NOT SIGNED IN:  Name input + "Ask to join" button
  //   2. SIGNED IN:      "Join now" button (no name input)
  //   3. ALREADY IN CALL: "Switch here" + "Other ways to join" → "Join here too"
  //
  // We race all three in parallel and handle whichever appears first.
  // =========================================================================
  console.log("Waiting for join UI...");

  // --- Selector strategies ---
  // Multiple selectors per element for resilience against Google UI changes.
  // If Google changes one selector, the others may still work.
  // Text-based selectors are preferred over class-based ones because Meet's
  // CSS classes are obfuscated and change on every deploy.
  const NAME_SELECTORS = [
    'input[aria-label="Your name"]',
    'input[placeholder="Your name"]',
    'input[type="text"][aria-label*="name" i]',
  ];

  const JOIN_BTN_STRATEGIES = [
    // XPath text match — most reliable currently
    '::-p-xpath(//button[contains(., "Ask to join") or contains(., "Join now")])',
    // aria-label fallback
    'button[aria-label="Ask to join"], button[aria-label="Join now"]',
    // data-attribute fallback (Material Design Components)
    '[data-mdc-dialog-action="join"]',
  ];

  // "Already in call" — shown when the signed-in user is already on the call
  // from another device/tab.
  const ALREADY_IN_CALL_STRATEGIES = [
    '::-p-xpath(//button[contains(., "Other ways to join")])',
    '::-p-xpath(//button[contains(., "Switch here")])',
  ];

  // --- Helper: atomic find+click for join buttons ---
  // Meet re-renders aggressively (React). If we use waitForSelector to get a
  // handle and then call handle.click(), Meet may re-render between those two
  // steps, detaching the node and causing "Node is detached from document".
  // Instead, we find AND click inside a single page.evaluate() call — entirely
  // in the browser's JS context with no round-trip to Puppeteer in between.
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

  // --- Helper: click any element by its visible text ---
  // Many Meet UI elements aren't standard <button> tags — they're styled spans,
  // divs, or custom elements. This uses a TreeWalker to find actual text nodes
  // and clicks the parent element. Works regardless of the element type.
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

  // --- Handler: "already in call" flow ---
  // When the user is already on the call from another device, Meet shows
  // "Switch here" (takes over) and "Other ways to join" (dropdown).
  // We want "Join here too" which is hidden behind the dropdown.
  async function joinWhenAlreadyInCall() {
    // First check if "Join here too" is already visible (dropdown pre-expanded)
    let clicked = await clickByText("Join here too", 1);
    if (clicked) return true;

    // Expand the "Other ways to join" dropdown
    const expanded = await clickByText("Other ways to join", 3);
    if (!expanded) {
      console.log("Could not expand 'Other ways to join' dropdown");
      return false;
    }

    await sleep(700);

    // Now click "Join here too"
    clicked = await clickByText("Join here too", 5);
    return clicked;
  }

  // --- Helper: race multiple selectors, first visible match wins ---
  // Each selector is tried in parallel. Individual timeouts are swallowed so
  // a failing selector doesn't reject the whole race (the others keep trying).
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
          .catch(() => {}); // swallow — another selector may still win
      }

      setTimeout(() => {
        if (!settled) reject(new Error("No selector matched"));
      }, timeout + 1000);
    });
  }

  // --- Main race: detect which join UI we're looking at ---
  // All three UI states are raced in parallel. First one to show a visible
  // element wins and determines which join path we take.
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

    // Overall timeout — if nothing is found in 17s, give up
    setTimeout(() => {
      if (!settled) reject(new Error("timeout"));
    }, 17000);
  }).catch(() => null);

  // --- Handle each join path ---
  if (!firstElement) {
    // FALLBACK: No join UI found automatically.
    // In headless mode, save a debug screenshot and exit.
    // In visible mode, ask the user to click manually and wait.
    if (headless) {
      const screenshotPath = "/tmp/meet-bot-debug.png";
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log("\n⚠  Could not find the join UI automatically (headless mode).");
      console.log(`   Debug screenshot saved to: ${screenshotPath}`);
      console.log("   Try again without --headless to debug. Exiting.");
      await browser.close();
      process.exit(1);
    }
    console.log("\n⚠  Could not find the join UI automatically.");
    console.log("   Please click the join button in the browser window.");
    console.log("   Waiting for you to join...\n");

    // Watch for the "Leave call" button — it only appears once in the meeting.
    const inMeeting = await page
      .waitForSelector('[aria-label="Leave call"]', {
        visible: true,
        timeout: 120000, // 2 min for manual intervention
      })
      .catch(() => null);

    if (!inMeeting) {
      console.log("Timed out waiting for manual join. Exiting.");
      await browser.close();
      process.exit(1);
    }
    console.log("Joined (manual)!");
  } else if (firstElement.type === "name") {
    // PATH: Not signed in — fill in the bot name, then click join.
    await firstElement.el.click({ clickCount: 3 });
    await firstElement.el.type(BOT_NAME);
    console.log(`Entered name: ${BOT_NAME}`);

    // Wait for the join button to appear, then click it atomically.
    await findWithFallbacks(JOIN_BTN_STRATEGIES, 10000).catch(() => null);
    const clicked = await clickJoinButton();
    if (clicked) {
      console.log("Clicked join button!");
    } else {
      if (headless) {
        console.log("\n⚠  Could not find the join button (headless mode). Exiting.");
        await browser.close();
        process.exit(1);
      }
      console.log("\n⚠  Could not find the join button automatically.");
      console.log("   Please click it in the browser window.\n");
      await page
        .waitForSelector('[aria-label="Leave call"]', {
          visible: true,
          timeout: 120000,
        })
        .catch(() => null);
    }
  } else if (firstElement.type === "already_in_call") {
    // PATH: Already in this call on another device/tab.
    // Must expand "Other ways to join" dropdown, then click "Join here too".
    console.log("Already in this call — joining as additional device...");
    const clicked = await joinWhenAlreadyInCall();
    if (clicked) {
      console.log("Clicked 'Join here too'!");
    } else {
      console.log("Could not click 'Join here too' — check browser window");
    }
  } else {
    // PATH: Signed in, not already in call — "Join now" button is directly visible.
    const clicked = await clickJoinButton();
    if (clicked) {
      console.log("Clicked join button!");
    } else {
      console.log("Join button found but click failed — check browser window");
    }
  }

  // =========================================================================
  // IN-MEETING: wait for user to quit
  // =========================================================================
  console.log("\nBot is in the meeting. Press 'q' to leave gracefully.\n");

  let leaving = false;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (key) => {
    const ch = key.toString();
    if (ch === "q" || ch === "Q" || key[0] === 3) {
      leaveGracefully();
    }
  });

  process.on("SIGINT", () => leaveGracefully());

  // =========================================================================
  // GRACEFUL EXIT
  // Tries 4 strategies to click Meet's leave button, then force-closes.
  // Multiple strategies because Meet's leave button markup isn't always a
  // standard <button> and can vary. The 5s force-exit timeout guarantees
  // we always exit even if the browser is unresponsive.
  // =========================================================================
  function leaveGracefully() {
    if (leaving) return;
    leaving = true;
    console.log("Leaving meeting...");

    // Absolute guarantee: force exit after 5s no matter what
    const forceExit = setTimeout(() => {
      console.log("Force closing...");
      browser.close().catch(() => {});
      process.exit(0);
    }, 5000);

    (async () => {
      try {
        // Strategy 1: aria-label selector (most common)
        await page.evaluate(() => {
          const btn = document.querySelector('[aria-label="Leave call"]');
          if (btn) { btn.click(); return; }
        });
        await sleep(500);

        // Strategy 2: text content search via TreeWalker
        await page.evaluate(() => {
          const walker = document.createTreeWalker(
            document.body, NodeFilter.SHOW_TEXT, null
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
        // (background color or material icon name)
        await page.evaluate(() => {
          const btns = document.querySelectorAll('button[aria-label*="eave"], [data-tooltip*="eave"], button');
          for (const btn of btns) {
            const style = window.getComputedStyle(btn);
            if (style.backgroundColor.includes("234") ||
                btn.innerHTML.includes("call_end") ||
                btn.getAttribute("aria-label")?.toLowerCase().includes("leave")) {
              btn.click();
              return;
            }
          }
        });
        await sleep(500);

        // Strategy 4: just close the tab — triggers Meet's leave flow
        await page.keyboard.down("Control");
        await page.keyboard.press("KeyW");
        await page.keyboard.up("Control");
        await sleep(500);
      } catch (e) {
        // Browser may already be closed, that's fine
      }

      clearTimeout(forceExit);
      await browser.close().catch(() => {});
      process.exit(0);
    })();
  }
})();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
