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

type View = "dashboard" | "detail" | "macros" | "tree";

interface Macro {
  key: string;       // display key
  label: string;     // display label
  command: string;   // text to send
  sendEnter: boolean;
}

// Common macros for agentic coding tools
const MACROS: Macro[] = [
  { key: "1", label: "y (approve)", command: "y", sendEnter: true },
  { key: "2", label: "n (deny)", command: "n", sendEnter: true },
  { key: "3", label: "Ctrl+C", command: "", sendEnter: false },  // special: send key
  { key: "4", label: "resume", command: "resume", sendEnter: true },
  { key: "5", label: "status", command: "/status", sendEnter: true },
  { key: "6", label: "clear", command: "/clear", sendEnter: true },
  { key: "7", label: "compact", command: "/compact", sendEnter: true },
  { key: "8", label: "help", command: "/help", sendEnter: true },
];

type Filter = "all" | "running" | "needs_input" | "idle";

interface State {
  view: View;
  workspaces: Workspace[];
  filteredWorkspaces: Workspace[];
  filter: Filter;
  cursor: number;
  screenLines: string[];
  inputBuffer: string;
  error: string;
  lastRefresh: number;
  lastDetailRefresh: number;
  refreshing: boolean;
  detailAutoRefresh: boolean;
  notifications: boolean;
  previousStatuses: Map<string, string>;
  notificationQueue: string[];
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
      ref: m[2]!,
      name: m[3]!.trim(),
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
  try {
    const raw = await cmux("read-screen", "--workspace", ref);
    return raw.split("\n").slice(0, 200);
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (msg.includes("Terminal surface not found")) {
      return ["", " ⏳ Terminal surface not ready — workspace may still be loading.", "", " Press 'r' to retry."];
    }
    return ["", ` ⚠ Error reading screen: ${msg}`, "", " Press 'r' to retry."];
  }
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  if (!Bun.env.CMUX_SOCKET_PASSWORD) {
    console.error("CMUX_SOCKET_PASSWORD is not set.");
    process.exit(1);
  }

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,  // We handle Ctrl+C ourselves (send to workspace in detail view)
    targetFps: 10,
    useMouse: false,
  });

  const W = renderer.width;
  const H = renderer.height;

  const state: State = {
    view: "dashboard",
    workspaces: [],
    filteredWorkspaces: [],
    filter: "all",
    cursor: 0,
    screenLines: [],
    inputBuffer: "",
    error: "",
    lastRefresh: 0,
    lastDetailRefresh: 0,
    refreshing: false,
    detailAutoRefresh: true,
    notifications: true,
    previousStatuses: new Map(),
    notificationQueue: [],
  };

  // Helper to apply current filter
  function applyFilter() {
    if (state.filter === "all") {
      state.filteredWorkspaces = state.workspaces;
    } else {
      state.filteredWorkspaces = state.workspaces.filter(w => w.status === state.filter);
    }
    if (state.cursor >= state.filteredWorkspaces.length) {
      state.cursor = Math.max(0, state.filteredWorkspaces.length - 1);
    }
  }

  // Check for status changes and queue notifications
  function checkNotifications(newWorkspaces: Workspace[]) {
    if (!state.notifications || state.previousStatuses.size === 0) {
      // First load — just record statuses, don't notify
      for (const ws of newWorkspaces) {
        state.previousStatuses.set(ws.ref, ws.status);
      }
      return;
    }
    for (const ws of newWorkspaces) {
      const prev = state.previousStatuses.get(ws.ref);
      if (prev && prev !== ws.status) {
        const emoji = ws.status === "needs_input" ? "⏳" : ws.status === "running" ? "⚡" : "○";
        state.notificationQueue.push(`${emoji} ${ws.name}: ${prev.replace("_", " ")} → ${ws.status.replace("_", " ")}`);
      }
      state.previousStatuses.set(ws.ref, ws.status);
    }
  }

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

  // Inline input prompt (lives inside detail view, row above footer)
  const detailInputLine = new TextRenderable(renderer, {
    id: "detail-input",
    position: "absolute",
    left: 1,
    top: H - 3,
    content: "",
    zIndex: 15,
  });
  detailGroup.add(detailInputLine);

  renderer.root.add(detailGroup);

  // === MACROS VIEW ===
  const macrosGroup = new BoxRenderable(renderer, {
    id: "macros-group",
    zIndex: 1,
    visible: false,
  });

  const macrosHeader = new TextRenderable(renderer, {
    id: "macros-header",
    position: "absolute",
    left: 1,
    top: 0,
    content: "",
    zIndex: 10,
  });
  macrosGroup.add(macrosHeader);

  const macroRows: TextRenderable[] = [];
  for (let i = 0; i < MACROS.length; i++) {
    const row = new TextRenderable(renderer, {
      id: `macro-${i}`,
      position: "absolute",
      left: 3,
      top: 2 + i,
      content: "",
      zIndex: 5,
    });
    macrosGroup.add(row);
    macroRows.push(row);
  }

  const macrosFooter = new TextRenderable(renderer, {
    id: "macros-footer",
    position: "absolute",
    left: 1,
    top: H - 1,
    content: "",
    zIndex: 10,
  });
  macrosGroup.add(macrosFooter);

  renderer.root.add(macrosGroup);

  // === TREE VIEW ===
  const treeGroup = new BoxRenderable(renderer, {
    id: "tree-group",
    zIndex: 1,
    visible: false,
  });

  const treeHeader = new TextRenderable(renderer, {
    id: "tree-header",
    position: "absolute",
    left: 1,
    top: 0,
    content: "",
    zIndex: 10,
  });
  treeGroup.add(treeHeader);

  const MAX_TREE_LINES = 60;
  const treeRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_TREE_LINES; i++) {
    const row = new TextRenderable(renderer, {
      id: `tree-${i}`,
      position: "absolute",
      left: 1,
      top: 2 + i,
      content: "",
      zIndex: 5,
    });
    treeGroup.add(row);
    treeRows.push(row);
  }

  const treeFooter = new TextRenderable(renderer, {
    id: "tree-footer",
    position: "absolute",
    left: 1,
    top: H - 1,
    content: "",
    zIndex: 10,
  });
  treeGroup.add(treeFooter);

  renderer.root.add(treeGroup);

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
    macrosGroup.visible = v === "macros";
    treeGroup.visible = v === "tree";
  }

  // ─── Render functions ───────────────────────────────────────
  function renderDashboard() {
    const ws = state.filteredWorkspaces;
    const refreshIcon = state.refreshing ? " ↻" : "";
    const filterLabel = state.filter === "all" ? "" : ` [${state.filter.replace("_", " ")}]`;
    const notifIcon = state.notifications ? " 🔔" : "";

    dashHeader.content = t`${bold(accent("cmux Remote"))} ${dim(`(${ws.length}/${state.workspaces.length} workspaces${refreshIcon}${filterLabel}${notifIcon})`)}`;

    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i >= ws.length) {
        dashRows[i]!.content = "";
        continue;
      }

      const w = ws[i]!;
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

      dashRows[i]!.content = t`${selected ? accent(pointer) : dim(pointer)}${name} ${status}`;
    }

    // Show notification queue if any
    if (state.notificationQueue.length > 0) {
      const note = state.notificationQueue.shift()!;
      errorText.content = t`${yellow("▶")} ${note}`;
    }

    dashFooter.content = t`${dim("j/k")} select  ${dim("⏎")} open  ${dim("r")} refresh  ${dim("/")} filter  ${dim("n")} notify  ${dim("q")} quit`;
  }

  function renderDetail() {
    const ws = state.filteredWorkspaces[state.cursor];
    if (!ws) return;

    let statusFn: (s: string) => any;
    switch (ws.status) {
      case "running": statusFn = green; break;
      case "needs_input": statusFn = warn; break;
      default: statusFn = dim;
    }

    const autoIcon = state.detailAutoRefresh ? green("⟳") : dim("⟳");
    detailHeader.content = t`${bold(accent(ws.name))} ${statusFn(`[${ws.status.replace("_", " ")}]`)} ${dim(ws.ref)} ${autoIcon}`;

    // Leave room: header(1) + gap(1) + screen + gap(1) + input(1) + status(1) + footer(1)
    const visibleLines = Math.min(H - 6, MAX_SCREEN_LINES);
    for (let i = 0; i < MAX_SCREEN_LINES; i++) {
      if (i >= visibleLines || i >= state.screenLines.length) {
        screenRows[i]!.content = "";
        continue;
      }
      screenRows[i]!.content = state.screenLines[i]!.substring(0, W - 2);
    }

    // Inline input prompt — always visible, shows what you're typing
    if (state.inputBuffer.length > 0) {
      detailInputLine.content = t`${accent("❯")} ${state.inputBuffer}${fg("#4C8DFF")("█")}`;
    } else {
      detailInputLine.content = t`${dim("❯ type a command...")}`;
    }

    detailFooter.content = t`${dim("esc")} back  ${dim("^R")} refresh  ${dim("^A")} auto  ${dim("^T")} macros  ${dim("^F")} focus  ${dim("^C")} interrupt  ${dim("⏎")} send`;
  }

  function renderMacros() {
    const ws = state.filteredWorkspaces[state.cursor];
    if (!ws) return;

    macrosHeader.content = t`${bold(accent("Quick Macros"))} → ${ws.name}`;

    for (let i = 0; i < MACROS.length; i++) {
      const m = MACROS[i]!;
      macroRows[i]!.content = t`${accent(m.key)}  ${white(m.label)}${dim(m.command ? ` → "${m.command}"` : " → Ctrl+C")}`;
    }

    macrosFooter.content = t`${dim("1-8")} send macro  ${dim("esc")} back`;
  }

  async function renderTree() {
    treeHeader.content = t`${bold(accent("Session Tree"))} ${dim("(cmux tree --all)")}`;

    try {
      const raw = await cmux("tree", "--all");
      const lines = raw.split("\n");
      for (let i = 0; i < MAX_TREE_LINES; i++) {
        if (i >= lines.length) {
          treeRows[i]!.content = "";
          continue;
        }
        treeRows[i]!.content = lines[i]!.substring(0, W - 2);
      }
    } catch (e: any) {
      treeRows[0]!.content = t`${red("Error:")} ${e?.message || String(e)}`;
      for (let i = 1; i < MAX_TREE_LINES; i++) treeRows[i]!.content = "";
    }

    treeFooter.content = t`${dim("esc")} back  ${dim("r")} refresh`;
  }

  // ─── Keyboard handler ───────────────────────────────────────
  renderer.keyInput.on("keypress", async (key: KeyEvent) => {
    try {
      // Clear errors on any keypress
      errorText.content = "";

      if (state.view === "dashboard") {
        // Ctrl+C on dashboard quits
        if (key.ctrl && key.name === "c") {
          renderer.stop();
          process.exit(0);
        }

        switch (key.name) {
          case "q":
            renderer.stop();
            process.exit(0);

          case "j":
          case "down":
            state.cursor = Math.min(state.cursor + 1, state.filteredWorkspaces.length - 1);
            renderDashboard();
            break;

          case "k":
          case "up":
            state.cursor = Math.max(state.cursor - 1, 0);
            renderDashboard();
            break;

          case "return":
            if (state.filteredWorkspaces.length > 0) {
              showView("detail");
              state.lastDetailRefresh = Date.now();
              state.screenLines = await fetchScreen(state.filteredWorkspaces[state.cursor]!.ref);
              renderDetail();
            }
            break;

          case "r":
            if (!state.refreshing) {
              state.refreshing = true;
              renderDashboard();
              state.workspaces = await fetchWorkspaces();
              checkNotifications(state.workspaces);
              state.lastRefresh = Date.now();
              state.refreshing = false;
              applyFilter();
              renderDashboard();
            }
            break;

          case "t":
            showView("tree");
            await renderTree();
            break;

          case "n":
            state.notifications = !state.notifications;
            errorText.content = t`${state.notifications ? green("🔔 Notifications ON") : dim("🔕 Notifications OFF")}`;
            renderDashboard();
            break;
        }

        // Filter with / key (detected by sequence since "name" may vary)
        if (key.sequence === "/") {
          const filters: Filter[] = ["all", "running", "needs_input", "idle"];
          const idx = filters.indexOf(state.filter);
          state.filter = filters[(idx + 1) % filters.length]!;
          applyFilter();
          errorText.content = t`${accent("Filter:")} ${state.filter === "all" ? "showing all" : state.filter.replace("_", " ")}`;
          renderDashboard();
        }

      } else if (state.view === "detail") {
        const ws = state.filteredWorkspaces[state.cursor];
        if (!ws) return;

        // Ctrl+ commands (check ctrl flag or raw sequence)
        const isCtrl = key.ctrl === true;

        if (key.name === "escape") {
          if (state.inputBuffer.length > 0) {
            // Esc with text in buffer → clear buffer
            state.inputBuffer = "";
            renderDetail();
          } else {
            // Esc with empty buffer → back to dashboard
            showView("dashboard");
            renderDashboard();
          }
        } else if (isCtrl && key.name === "r") {
          // Ctrl+R → refresh
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = Date.now();
          renderDetail();
        } else if (isCtrl && key.name === "a") {
          // Ctrl+A → toggle auto-refresh
          state.detailAutoRefresh = !state.detailAutoRefresh;
          errorText.content = t`${state.detailAutoRefresh ? green("⟳ Auto-refresh ON (3s)") : dim("⟳ Auto-refresh OFF")}`;
          renderDetail();
        } else if (isCtrl && key.name === "t") {
          // Ctrl+T → macros menu
          showView("macros");
          renderMacros();
        } else if (isCtrl && key.name === "f") {
          // Ctrl+F → focus workspace on Mac
          await cmux("select-workspace", "--workspace", ws.ref);
          errorText.content = t`${green("Focused")} ${ws.name}`;
        } else if (isCtrl && key.name === "c") {
          // Ctrl+C → send Ctrl+C to workspace
          await cmux("send-key", "--workspace", ws.ref, "Ctrl+C");
          errorText.content = t`${yellow("Sent Ctrl+C")} → ${ws.name}`;
          await Bun.sleep(300);
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = Date.now();
          renderDetail();
        } else if (key.name === "return") {
          // Enter → send buffer contents (or just Enter if empty)
          if (state.inputBuffer.trim()) {
            await cmux("send", "--workspace", ws.ref, state.inputBuffer);
            await cmux("send-key", "--workspace", ws.ref, "Enter");
            state.inputBuffer = "";
          } else {
            await cmux("send-key", "--workspace", ws.ref, "Enter");
          }
          await Bun.sleep(300);
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = Date.now();
          renderDetail();
        } else if (key.name === "backspace" || key.name === "delete") {
          state.inputBuffer = state.inputBuffer.slice(0, -1);
          renderDetail();
        } else if (key.name === "tab") {
          // Tab → send tab to workspace (useful for autocomplete)
          await cmux("send-key", "--workspace", ws.ref, "Tab");
          await Bun.sleep(200);
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = Date.now();
          renderDetail();
        } else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
          // Printable character → add to input buffer
          state.inputBuffer += key.sequence;
          renderDetail();
        }

      } else if (state.view === "macros") {
        if (key.name === "escape") {
          showView("detail");
          renderDetail();
        } else {
          const macroIdx = parseInt(key.sequence || "", 10) - 1;
          const macro = macroIdx >= 0 && macroIdx < MACROS.length ? MACROS[macroIdx] : undefined;
          const ws = state.filteredWorkspaces[state.cursor];
          if (macro && ws) {
            if (macro.key === "3") {
              await cmux("send-key", "--workspace", ws.ref, "Ctrl+C");
            } else {
              await cmux("send", "--workspace", ws.ref, macro.command);
              if (macro.sendEnter) {
                await cmux("send-key", "--workspace", ws.ref, "Enter");
              }
            }
            errorText.content = t`${green("Sent:")} ${macro.label} → ${ws.name}`;
            await Bun.sleep(300);
            state.screenLines = await fetchScreen(ws.ref);
            state.lastDetailRefresh = Date.now();
            showView("detail");
            renderDetail();
          }
        }

      } else if (state.view === "tree") {
        if (key.name === "escape") {
          showView("dashboard");
          renderDashboard();
        } else if (key.name === "r") {
          await renderTree();
        }
      }
    } catch (err: any) {
      errorText.content = t`${red("Error:")} ${err.message?.substring(0, W - 10) || String(err)}`;
    }
  });

  // ─── Auto-refresh via frame callback ────────────────────────
  renderer.setFrameCallback(async () => {
    const now = Date.now();

    // Dashboard auto-refresh every 5s
    if (state.view === "dashboard" && !state.refreshing && now - state.lastRefresh > 5000) {
      state.refreshing = true;
      try {
        state.workspaces = await fetchWorkspaces();
        checkNotifications(state.workspaces);
        state.lastRefresh = now;
        applyFilter();
        renderDashboard();
      } catch {}
      state.refreshing = false;
    }

    // Detail view auto-refresh every 3s when enabled
    if (state.view === "detail" && state.detailAutoRefresh && now - state.lastDetailRefresh > 3000) {
      try {
        const ws = state.filteredWorkspaces[state.cursor];
        if (ws) {
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = now;
          renderDetail();
        }
      } catch {}
    }
  });

  // ─── Initial load ───────────────────────────────────────────
  renderer.setBackgroundColor("#0d1117");
  state.workspaces = await fetchWorkspaces();
  checkNotifications(state.workspaces);
  state.lastRefresh = Date.now();
  applyFilter();
  showView("dashboard");
  renderDashboard();
  renderer.start();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
