import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  t,
  bold,
  fg,
  green,
  red,
  blue,
  yellow,
  white,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";

// ─── Helpers ────────────────────────────────────────────────────
const gray = (s: string) => fg("#666666")(s);
const dim = (s: string) => fg("#888888")(s);
const accent = (s: string) => fg("#4C8DFF")(s);
const warn = (s: string) => fg("#FFA500")(s);

// ─── Types ──────────────────────────────────────────────────────
interface Workspace {
  ref: string;
  name: string;
  isActive: boolean;
  status: "running" | "needs_input" | "idle";
  statusRaw: string;
}

type View = "dashboard" | "detail" | "input";

interface State {
  view: View;
  workspaces: Workspace[];
  cursor: number;
  screenLines: string[];
  inputBuffer: string;
  error: string;
  lastRefresh: number;
  refreshing: boolean;
}

// ─── cmux CLI wrapper ───────────────────────────────────────────
async function cmux(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["cmux", ...args], {
    env: Bun.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim());
  return stdout.trim();
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  const raw = await cmux("list-workspaces");
  const lines = raw.split("\n").filter((l) => l.trim());
  const workspaces: Workspace[] = [];

  for (const line of lines) {
    const m = line.match(/^([*\s])\s*(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?$/);
    if (!m) continue;
    workspaces.push({
      ref: m[2],
      name: m[3].trim(),
      isActive: m[1] === "*" || line.includes("[selected]"),
      status: "idle",
      statusRaw: "",
    });
  }

  // Fetch statuses in parallel
  await Promise.allSettled(
    workspaces.map(async (ws) => {
      try {
        const s = await cmux("list-status", "--workspace", ws.ref);
        ws.statusRaw = s;
        if (s.includes("Needs input") || s.includes("Needs Input")) ws.status = "needs_input";
        else if (s.includes("Running")) ws.status = "running";
      } catch {}
    })
  );

  return workspaces;
}

async function fetchScreen(ref: string): Promise<string[]> {
  const raw = await cmux("read-screen", "--workspace", ref);
  return raw.split("\n").slice(0, 200);
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  if (!Bun.env.CMUX_SOCKET_PASSWORD) {
    console.error("CMUX_SOCKET_PASSWORD is not set.");
    process.exit(1);
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 10,
    useMouse: false,
  });

  const W = renderer.width;
  const H = renderer.height;

  const state: State = {
    view: "dashboard",
    workspaces: [],
    cursor: 0,
    screenLines: [],
    inputBuffer: "",
    error: "",
    lastRefresh: 0,
    refreshing: false,
  };

  // ─── UI Elements ────────────────────────────────────────────
  // We create a main group per view and toggle visibility

  // === DASHBOARD VIEW ===
  const dashGroup = new BoxRenderable(renderer, {
    id: "dash",
    zIndex: 1,
  });

  const dashHeader = new TextRenderable(renderer, {
    id: "dash-header",
    position: "absolute",
    left: 1,
    top: 0,
    content: "",
    zIndex: 10,
  });
  dashGroup.add(dashHeader);

  // Workspace rows - pre-create slots for up to 20 workspaces
  const MAX_SLOTS = 20;
  const dashRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const row = new TextRenderable(renderer, {
      id: `dash-row-${i}`,
      position: "absolute",
      left: 1,
      top: 2 + i,
      content: "",
      zIndex: 5,
    });
    dashGroup.add(row);
    dashRows.push(row);
  }

  const dashFooter = new TextRenderable(renderer, {
    id: "dash-footer",
    position: "absolute",
    left: 1,
    top: H - 1,
    content: "",
    zIndex: 10,
  });
  dashGroup.add(dashFooter);

  renderer.root.add(dashGroup);

  // === DETAIL VIEW ===
  const detailGroup = new BoxRenderable(renderer, {
    id: "detail",
    zIndex: 1,
    visible: false,
  });

  const detailHeader = new TextRenderable(renderer, {
    id: "detail-header",
    position: "absolute",
    left: 1,
    top: 0,
    content: "",
    zIndex: 10,
  });
  detailGroup.add(detailHeader);

  // Screen content lines
  const MAX_SCREEN_LINES = 100;
  const screenRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_SCREEN_LINES; i++) {
    const row = new TextRenderable(renderer, {
      id: `screen-${i}`,
      position: "absolute",
      left: 1,
      top: 2 + i,
      content: "",
      zIndex: 5,
    });
    detailGroup.add(row);
    screenRows.push(row);
  }

  const detailFooter = new TextRenderable(renderer, {
    id: "detail-footer",
    position: "absolute",
    left: 1,
    top: H - 1,
    content: "",
    zIndex: 10,
  });
  detailGroup.add(detailFooter);

  renderer.root.add(detailGroup);

  // === INPUT VIEW ===
  const inputGroup = new BoxRenderable(renderer, {
    id: "input-group",
    zIndex: 1,
    visible: false,
  });

  const inputHeader = new TextRenderable(renderer, {
    id: "input-header",
    position: "absolute",
    left: 1,
    top: 0,
    content: "",
    zIndex: 10,
  });
  inputGroup.add(inputHeader);

  const inputPrompt = new TextRenderable(renderer, {
    id: "input-prompt",
    position: "absolute",
    left: 1,
    top: 2,
    content: "",
    zIndex: 10,
  });
  inputGroup.add(inputPrompt);

  const inputFooter = new TextRenderable(renderer, {
    id: "input-footer",
    position: "absolute",
    left: 1,
    top: H - 1,
    content: "",
    zIndex: 10,
  });
  inputGroup.add(inputFooter);

  renderer.root.add(inputGroup);

  // === ERROR OVERLAY ===
  const errorText = new TextRenderable(renderer, {
    id: "error-text",
    position: "absolute",
    left: 1,
    top: H - 2,
    content: "",
    zIndex: 100,
  });
  renderer.root.add(errorText);

  // ─── View switching ─────────────────────────────────────────
  function showView(v: View) {
    state.view = v;
    dashGroup.visible = v === "dashboard";
    detailGroup.visible = v === "detail";
    inputGroup.visible = v === "input";
  }

  // ─── Render functions ───────────────────────────────────────
  function renderDashboard() {
    const ws = state.workspaces;
    const refreshIcon = state.refreshing ? " ↻" : "";

    dashHeader.content = t`${bold(accent("cmux Remote"))} ${dim(`(${ws.length} workspaces${refreshIcon})`)}`;

    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i >= ws.length) {
        dashRows[i].content = "";
        continue;
      }

      const w = ws[i];
      const selected = i === state.cursor;
      const pointer = selected ? "▸ " : "  ";

      let statusIcon: string;
      let statusFn: (s: string) => any;
      switch (w.status) {
        case "running":
          statusIcon = "⚡";
          statusFn = green;
          break;
        case "needs_input":
          statusIcon = "⏳";
          statusFn = warn;
          break;
        default:
          statusIcon = "○";
          statusFn = dim;
      }

      const name = selected ? bold(white(w.name)) : w.name;
      const status = statusFn(`${statusIcon} ${w.status.replace("_", " ")}`);

      dashRows[i].content = t`${selected ? accent(pointer) : dim(pointer)}${name} ${status}`;
    }

    dashFooter.content = t`${dim("j/k")} select  ${dim("⏎")} open  ${dim("r")} refresh  ${dim("q")} quit`;
  }

  function renderDetail() {
    const ws = state.workspaces[state.cursor];
    if (!ws) return;

    let statusFn: (s: string) => any;
    switch (ws.status) {
      case "running": statusFn = green; break;
      case "needs_input": statusFn = warn; break;
      default: statusFn = dim;
    }

    detailHeader.content = t`${bold(accent(ws.name))} ${statusFn(`[${ws.status.replace("_", " ")}]`)} ${dim(ws.ref)}`;

    const visibleLines = Math.min(H - 4, MAX_SCREEN_LINES);
    for (let i = 0; i < MAX_SCREEN_LINES; i++) {
      if (i >= visibleLines || i >= state.screenLines.length) {
        screenRows[i].content = "";
        continue;
      }
      // Truncate to terminal width
      screenRows[i].content = state.screenLines[i].substring(0, W - 2);
    }

    detailFooter.content = t`${dim("esc")} back  ${dim("r")} refresh  ${dim("i")} input  ${dim("f")} focus  ${dim("⏎")} send Enter`;
  }

  function renderInput() {
    const ws = state.workspaces[state.cursor];
    if (!ws) return;

    inputHeader.content = t`${bold(accent("Send Command"))} → ${ws.name}`;
    inputPrompt.content = t`${accent("❯")} ${state.inputBuffer}${fg("#4C8DFF")("█")}`;
    inputFooter.content = t`${dim("⏎")} send  ${dim("esc")} cancel`;
  }

  // ─── Keyboard handler ───────────────────────────────────────
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    try {
      // Clear errors on any keypress
      errorText.content = "";

      if (state.view === "dashboard") {
        switch (key.name) {
          case "q":
            renderer.stop();
            process.exit(0);

          case "j":
          case "down":
            state.cursor = Math.min(state.cursor + 1, state.workspaces.length - 1);
            renderDashboard();
            break;

          case "k":
          case "up":
            state.cursor = Math.max(state.cursor - 1, 0);
            renderDashboard();
            break;

          case "return":
            if (state.workspaces.length > 0) {
              showView("detail");
              state.screenLines = await fetchScreen(state.workspaces[state.cursor].ref);
              renderDetail();
            }
            break;

          case "r":
            if (!state.refreshing) {
              state.refreshing = true;
              renderDashboard();
              state.workspaces = await fetchWorkspaces();
              state.lastRefresh = Date.now();
              state.refreshing = false;
              if (state.cursor >= state.workspaces.length) state.cursor = 0;
              renderDashboard();
            }
            break;
        }

      } else if (state.view === "detail") {
        switch (key.name) {
          case "escape":
            showView("dashboard");
            renderDashboard();
            break;

          case "r":
            state.screenLines = await fetchScreen(state.workspaces[state.cursor].ref);
            renderDetail();
            break;

          case "i":
            state.inputBuffer = "";
            showView("input");
            renderInput();
            break;

          case "f":
            await cmux("select-workspace", "--workspace", state.workspaces[state.cursor].ref);
            errorText.content = t`${green("Focused")} ${state.workspaces[state.cursor].name}`;
            break;

          case "return":
            // Quick send Enter to workspace
            await cmux("send-key", "--workspace", state.workspaces[state.cursor].ref, "Enter");
            await Bun.sleep(300);
            state.screenLines = await fetchScreen(state.workspaces[state.cursor].ref);
            renderDetail();
            break;
        }

      } else if (state.view === "input") {
        if (key.name === "escape") {
          showView("detail");
          renderDetail();
        } else if (key.name === "return") {
          if (state.inputBuffer.trim()) {
            const ref = state.workspaces[state.cursor].ref;
            await cmux("send", "--workspace", ref, state.inputBuffer);
            await cmux("send-key", "--workspace", ref, "Enter");
            await Bun.sleep(300);
            state.screenLines = await fetchScreen(ref);
          }
          state.inputBuffer = "";
          showView("detail");
          renderDetail();
        } else if (key.name === "backspace" || key.name === "delete") {
          state.inputBuffer = state.inputBuffer.slice(0, -1);
          renderInput();
        } else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
          // Printable character
          state.inputBuffer += key.sequence;
          renderInput();
        }
      }
    } catch (err: any) {
      errorText.content = t`${red("Error:")} ${err.message?.substring(0, W - 10) || String(err)}`;
    }
  });

  // ─── Auto-refresh via frame callback ────────────────────────
  renderer.setFrameCallback(async () => {
    const now = Date.now();
    if (state.view === "dashboard" && !state.refreshing && now - state.lastRefresh > 5000) {
      state.refreshing = true;
      try {
        state.workspaces = await fetchWorkspaces();
        state.lastRefresh = now;
        if (state.cursor >= state.workspaces.length) state.cursor = 0;
        renderDashboard();
      } catch {}
      state.refreshing = false;
    }
  });

  // ─── Initial load ───────────────────────────────────────────
  renderer.setBackgroundColor("#0d1117");
  state.workspaces = await fetchWorkspaces();
  state.lastRefresh = Date.now();
  showView("dashboard");
  renderDashboard();
  renderer.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
