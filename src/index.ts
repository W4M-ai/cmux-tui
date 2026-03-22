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
  toolName: string;   // e.g., "claude_code", "codex", ""
  statusText: string; // e.g., "Needs input", "Idle", "Running"
  path: string;       // working directory from tree
  surfaceTitle: string; // active surface title (e.g., "✳ Admin panel...")
}

type View = "dashboard" | "detail" | "macros" | "tree" | "help";

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

// Quick-jump keys: 1-9, 0, then letters (skipping reserved dashboard keys j,k,n,q,r,t)
const JUMP_KEYS = "1234567890abcdefghilmopsuvwxyz";
const RESERVED_DASH_KEYS = new Set(["j", "k", "n", "q", "r", "t", "/", "?"]);

function jumpKeyForIndex(i: number): string {
  return i < JUMP_KEYS.length ? JUMP_KEYS[i]! : " ";
}

function indexForJumpKey(ch: string): number {
  const idx = JUMP_KEYS.indexOf(ch.toLowerCase());
  return idx;
}

type Filter = "all" | "running" | "needs_input" | "idle";

interface State {
  view: View;
  workspaces: Workspace[];
  filteredWorkspaces: Workspace[];
  filter: Filter;
  cursor: number;
  screenLines: string[];
  scrollOffset: number;     // scroll position in detail view
  inputBuffer: string;
  inputHistory: string[];
  historyIndex: number;       // -1 = not browsing history
  error: string;
  lastRefresh: number;
  lastDetailRefresh: number;
  refreshing: boolean;
  detailAutoRefresh: boolean;
  notifications: boolean;
  previousStatuses: Map<string, string>;
  notificationQueue: string[];
}

// Status priority for sorting (higher = more urgent, floats to top)
const STATUS_PRIORITY: Record<string, number> = {
  needs_input: 2,
  running: 1,
  idle: 0,
};

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
  // Fetch workspace list and tree in parallel
  const [rawList, rawTree] = await Promise.all([
    cmux("list-workspaces"),
    cmux("tree", "--all").catch(() => ""),
  ]);

  const lines = rawList.split("\n").filter((l) => l.trim());
  const workspaces: Workspace[] = [];

  // Parse tree to extract paths and surface titles per workspace
  const treePaths = new Map<string, string>();
  const treeSurfaces = new Map<string, string>();
  if (rawTree) {
    let currentRef = "";
    for (const tline of rawTree.split("\n")) {
      // Match workspace lines: workspace workspace:2 "SES Mailer Pro"
      const wsMatch = tline.match(/workspace (workspace:\d+)/);
      if (wsMatch) currentRef = wsMatch[1]!;

      // Match surface lines with titles
      if (currentRef && tline.includes("surface") && tline.includes("[terminal]")) {
        const titleMatch = tline.match(/"([^"]+)"(?:\s+\[selected\])?/);
        if (titleMatch) {
          const title = titleMatch[1]!;
          // First [selected] surface is the active one
          if (tline.includes("[selected]") && !treeSurfaces.has(currentRef)) {
            treeSurfaces.set(currentRef, title);
          }
          // Extract path from "user@host:~/path" format
          const pathMatch = title.match(/[^:]+:(~\/[^\s]+|\/[^\s]+)/);
          if (pathMatch && !treePaths.has(currentRef)) {
            treePaths.set(currentRef, pathMatch[1]!);
          }
        }
      }
    }
  }

  for (const line of lines) {
    // Match workspace lines — flexible leading chars to handle various cmux output formats
    const m = line.match(/(workspace:\d+)\s+(.+?)(?:\s+\[selected\])?\s*$/);
    if (!m) continue;
    const ref = m[1]!;
    workspaces.push({
      ref,
      name: m[2]!.trim(),
      isActive: line.includes("*") || line.includes("[selected]"),
      status: "idle",
      statusRaw: "",
      toolName: "",
      statusText: "",
      path: treePaths.get(ref) ?? "",
      surfaceTitle: treeSurfaces.get(ref) ?? "",
    });
  }

  // Fetch statuses in parallel
  await Promise.allSettled(
    workspaces.map(async (ws) => {
      try {
        const s = await cmux("list-status", "--workspace", ws.ref);
        ws.statusRaw = s;
        // Parse "claude_code=Needs input icon=..." or "claude_code=Running icon=..."
        const toolMatch = s.match(/^(\w+)=(.+?)\s+icon=/);
        if (toolMatch) {
          ws.toolName = toolMatch[1]!;
          ws.statusText = toolMatch[2]!;
        }
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

  // Phone mode: compact layout for narrow terminals
  const isPhone = W < 50;

  const state: State = {
    view: "dashboard",
    workspaces: [],
    filteredWorkspaces: [],
    filter: "all",
    cursor: 0,
    screenLines: [],
    scrollOffset: 0,
    inputBuffer: "",
    inputHistory: [],
    historyIndex: -1,
    error: "",
    lastRefresh: 0,
    lastDetailRefresh: 0,
    refreshing: false,
    detailAutoRefresh: true,
    notifications: true,
    previousStatuses: new Map(),
    notificationQueue: [],
  };

  // Helper to apply current filter + status-priority sorting
  function applyFilter() {
    let list = state.filter === "all"
      ? [...state.workspaces]
      : state.workspaces.filter(w => w.status === state.filter);

    // Sort: needs_input first, then running, then idle
    list.sort((a, b) => (STATUS_PRIORITY[b.status] ?? 0) - (STATUS_PRIORITY[a.status] ?? 0));

    state.filteredWorkspaces = list;
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
        // Terminal bell — triggers badge/vibration in iOS SSH apps
        if (ws.status === "needs_input") {
          process.stdout.write("\x07");
        }
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
  // Each workspace gets 2 rows on tablet (name + detail), 1 on phone
  const MAX_SLOTS = 20;
  const dashRows: TextRenderable[] = [];
  const dashDetailRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const rowTop = isPhone ? 2 + i : 2 + i * 2;
    const row = new TextRenderable(renderer, {
      id: `dash-row-${i}`,
      position: "absolute",
      left: 1,
      top: rowTop,
      content: "",
      zIndex: 5,
    });
    dashGroup.add(row);
    dashRows.push(row);

    // Detail row (path/tool) — only used on tablet
    const detailRow = new TextRenderable(renderer, {
      id: `dash-detail-${i}`,
      position: "absolute",
      left: 5,
      top: rowTop + 1,
      content: "",
      zIndex: 5,
    });
    dashGroup.add(detailRow);
    dashDetailRows.push(detailRow);
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

  // === HELP VIEW ===
  const helpGroup = new BoxRenderable(renderer, {
    id: "help-group",
    zIndex: 1,
    visible: false,
  });

  const helpHeader = new TextRenderable(renderer, {
    id: "help-header",
    position: "absolute",
    left: 1,
    top: 0,
    content: "",
    zIndex: 10,
  });
  helpGroup.add(helpHeader);

  const MAX_HELP_LINES = 30;
  const helpRows: TextRenderable[] = [];
  for (let i = 0; i < MAX_HELP_LINES; i++) {
    const row = new TextRenderable(renderer, {
      id: `help-${i}`,
      position: "absolute",
      left: 1,
      top: 2 + i,
      content: "",
      zIndex: 5,
    });
    helpGroup.add(row);
    helpRows.push(row);
  }

  const helpFooter = new TextRenderable(renderer, {
    id: "help-footer",
    position: "absolute",
    left: 1,
    top: H - 1,
    content: "",
    zIndex: 10,
  });
  helpGroup.add(helpFooter);

  renderer.root.add(helpGroup);

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
    helpGroup.visible = v === "help";
  }

  // ─── Render functions ───────────────────────────────────────
  function renderDashboard() {
    const ws = state.filteredWorkspaces;
    const refreshIcon = state.refreshing ? " ↻" : "";
    const filterLabel = state.filter === "all" ? "" : ` [${state.filter.replace("_", " ")}]`;
    const notifIcon = state.notifications ? " 🔔" : "";

    if (isPhone) {
      dashHeader.content = t`${bold(accent("cmux"))} ${dim(`${ws.length}ws${refreshIcon}${filterLabel}${notifIcon}`)}`;
    } else {
      dashHeader.content = t`${bold(accent("cmux Remote"))} ${dim(`(${ws.length}/${state.workspaces.length} workspaces${refreshIcon}${filterLabel}${notifIcon})`)}`;
    }

    for (let i = 0; i < MAX_SLOTS; i++) {
      if (i >= ws.length) {
        dashRows[i]!.content = "";
        dashDetailRows[i]!.content = "";
        continue;
      }

      const w = ws[i]!;
      const selected = i === state.cursor;
      const pointer = selected ? "▸ " : "  ";
      const jumpKey = jumpKeyForIndex(i);

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

      if (isPhone) {
        // Compact: "1 ▸ VoiceFlo ⏳" — truncate name to fit
        const maxName = W - 10;
        const truncName = w.name.length > maxName ? w.name.substring(0, maxName - 1) + "…" : w.name;
        const name = selected ? bold(white(truncName)) : truncName;
        dashRows[i]!.content = t`${dim(jumpKey)} ${selected ? accent(pointer) : dim(pointer)}${name} ${statusFn(statusIcon)}`;
        dashDetailRows[i]!.content = "";
      } else {
        // Tablet: 2-line rows — name + status, then path/tool info
        const name = selected ? bold(white(w.name)) : w.name;
        const statusLabel = w.statusText || w.status.replace("_", " ");
        const status = statusFn(`${statusIcon} ${statusLabel}`);
        dashRows[i]!.content = t`${dim(jumpKey)} ${selected ? accent(pointer) : dim(pointer)}${name} ${status}`;

        // Detail line: tool + path
        const parts: string[] = [];
        if (w.toolName) {
          const toolDisplay = w.toolName.replace("_", " ");
          parts.push(toolDisplay);
        }
        if (w.path) {
          // Shorten path: ~/Development/SES-Mailer-Pro → ~/Dev.../SES-Mailer-Pro
          const shortPath = w.path.replace(/^~\/Development\//, "~/…/");
          parts.push(shortPath);
        } else if (w.surfaceTitle && !w.surfaceTitle.startsWith("✳")) {
          // Use surface title as fallback if no path
          const maxTitle = W - 10;
          parts.push(w.surfaceTitle.length > maxTitle ? w.surfaceTitle.substring(0, maxTitle - 1) + "…" : w.surfaceTitle);
        }
        dashDetailRows[i]!.content = parts.length > 0 ? t`${dim(parts.join(" · "))}` : "";
      }
    }

    // Show notification queue if any
    if (state.notificationQueue.length > 0) {
      const note = state.notificationQueue.shift()!;
      errorText.content = t`${yellow("▶")} ${note}`;
    }

    if (isPhone) {
      dashFooter.content = t`${dim("1-0,a-z")} jump ${dim("⏎")} open ${dim("/")} filter ${dim("?")} help`;
    } else {
      dashFooter.content = t`${dim("1-0,a-z")} jump  ${dim("j/k")} select  ${dim("⏎")} open  ${dim("/")} filter  ${dim("?")} help  ${dim("q")} quit`;
    }
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
    const posLabel = dim(`[${state.cursor + 1}/${state.filteredWorkspaces.length}]`);

    // Scrollable screen content
    // Available rows: header(1) + gap(1) + screen + input(1) + error(1) + footer(1) = H - 5
    const visibleLines = Math.min(H - 5, MAX_SCREEN_LINES);
    const totalLines = state.screenLines.length;
    const maxScroll = Math.max(0, totalLines - visibleLines);

    // Auto-scroll to bottom when content exceeds visible area (unless user scrolled up)
    if (state.scrollOffset < 0) {
      // -1 means "follow bottom"
      state.scrollOffset = maxScroll;
    }
    // Clamp scroll offset
    state.scrollOffset = Math.min(state.scrollOffset, maxScroll);

    const scrollIndicator = totalLines > visibleLines
      ? dim(` [${state.scrollOffset + visibleLines}/${totalLines}]`)
      : "";

    // Re-render header with scroll info
    if (isPhone) {
      const maxName = W - 15;
      const truncName = ws.name.length > maxName ? ws.name.substring(0, maxName - 1) + "…" : ws.name;
      detailHeader.content = t`${bold(accent(truncName))} ${statusFn(`[${ws.status === "needs_input" ? "input" : ws.status}]`)} ${autoIcon}${scrollIndicator}`;
    } else {
      detailHeader.content = t`${bold(accent(ws.name))} ${statusFn(`[${ws.status.replace("_", " ")}]`)} ${posLabel} ${dim(ws.ref)} ${autoIcon}${scrollIndicator}`;
    }

    for (let i = 0; i < MAX_SCREEN_LINES; i++) {
      const srcIdx = i + state.scrollOffset;
      if (i >= visibleLines || srcIdx >= totalLines) {
        screenRows[i]!.content = "";
        continue;
      }
      screenRows[i]!.content = state.screenLines[srcIdx]!.substring(0, W - 2);
    }

    // Inline input prompt — always visible, shows what you're typing
    const histHint = state.historyIndex >= 0 ? dim(` (history ${state.historyIndex + 1}/${state.inputHistory.length})`) : "";
    if (state.inputBuffer.length > 0) {
      detailInputLine.content = t`${accent("❯")} ${state.inputBuffer}${fg("#4C8DFF")("█")}${histHint}`;
    } else {
      detailInputLine.content = t`${dim("❯ type a command...")}`;
    }

    if (isPhone) {
      detailFooter.content = t`${dim("esc")} back ${dim("◀▶")} prev/next ${dim("^U/D")} scroll ${dim("?")} help ${dim("⏎")} send`;
    } else {
      detailFooter.content = t`${dim("esc")} back  ${dim("◀▶")} prev/next  ${dim("↑↓")} history  ${dim("^U/^D")} scroll  ${dim("^R")} refresh  ${dim("^T")} macros  ${dim("?")} help  ${dim("⏎")} send`;
    }
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

  function renderHelp() {
    helpHeader.content = t`${bold(accent("Key Bindings"))}`;

    const lines = isPhone ? [
      t`${bold(white("Dashboard"))}`,
      t`  ${accent("1-0,a-z")}  Jump to workspace`,
      t`  ${accent("j/k")}  Move up/down`,
      t`  ${accent("⏎")}    Open workspace`,
      t`  ${accent("/")}    Cycle filter`,
      t`  ${accent("t")}    Session tree`,
      t`  ${accent("n")}    Toggle notifications`,
      t`  ${accent("r")}    Refresh`,
      t`  ${accent("q")}    Quit`,
      "",
      t`${bold(white("Detail View"))}`,
      t`  ${accent("type")}  Compose command`,
      t`  ${accent("⏎")}    Send to workspace`,
      t`  ${accent("◀ ▶")}  Prev/next workspace`,
      t`  ${accent("↑ ↓")}  Browse input history`,
      t`  ${accent("^U/D")} Scroll up/down`,
      t`  ${accent("^R")}   Refresh  ${accent("^A")} Auto`,
      t`  ${accent("^T")}   Macros   ${accent("^F")} Focus`,
      t`  ${accent("^C")}   Interrupt workspace`,
      t`  ${accent("esc")}  Clear / back`,
    ] : [
      t`${bold(white("Dashboard"))}`,
      t`  ${accent("1-0,a-z")}  Jump directly to workspace (letters skip j,k,n,q,r,t)`,
      t`  ${accent("j / k")}    Move cursor down / up`,
      t`  ${accent("Enter")}    Open workspace detail view`,
      t`  ${accent("/")}        Cycle filter (all → running → needs input → idle)`,
      t`  ${accent("t")}        Open session tree view`,
      t`  ${accent("n")}        Toggle notifications on/off`,
      t`  ${accent("r")}        Refresh workspace list`,
      t`  ${accent("q")}        Quit application`,
      "",
      t`${bold(white("Detail View (Direct Typing)"))}`,
      t`  ${accent("type")}     Characters go to the input buffer`,
      t`  ${accent("Enter")}    Send buffer to workspace (or just Enter if empty)`,
      t`  ${accent("← →")}      Switch to previous / next workspace`,
      t`  ${accent("↑ ↓")}      Browse input history`,
      t`  ${accent("Tab")}      Send Tab key to workspace`,
      t`  ${accent("Ctrl+U")}   Scroll up half page`,
      t`  ${accent("Ctrl+D")}   Scroll down half page`,
      t`  ${accent("PgUp/Dn")}  Scroll full page`,
      t`  ${accent("Ctrl+R")}   Refresh screen content`,
      t`  ${accent("Ctrl+A")}   Toggle auto-refresh (3s)`,
      t`  ${accent("Ctrl+T")}   Open quick macros menu`,
      t`  ${accent("Ctrl+F")}   Focus workspace on Mac display`,
      t`  ${accent("Ctrl+C")}   Send interrupt to workspace`,
      t`  ${accent("Esc")}      Clear input buffer, or back to dashboard`,
      "",
      t`${bold(white("Quick Macros"))}`,
      t`  ${accent("1")} approve  ${accent("2")} deny  ${accent("3")} Ctrl+C  ${accent("4")} resume`,
      t`  ${accent("5")} /status  ${accent("6")} /clear  ${accent("7")} /compact  ${accent("8")} /help`,
    ];

    for (let i = 0; i < MAX_HELP_LINES; i++) {
      helpRows[i]!.content = i < lines.length ? (lines[i] ?? "") : "";
    }

    helpFooter.content = t`${dim("esc")} close help`;
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
              state.scrollOffset = -1; // follow bottom on entry
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

        // Filter with / key
        if (key.sequence === "/") {
          const filters: Filter[] = ["all", "running", "needs_input", "idle"];
          const idx = filters.indexOf(state.filter);
          state.filter = filters[(idx + 1) % filters.length]!;
          applyFilter();
          errorText.content = t`${accent("Filter:")} ${state.filter === "all" ? "showing all" : state.filter.replace("_", " ")}`;
          renderDashboard();
        }

        // Help with ? key
        if (key.sequence === "?") {
          showView("help");
          renderHelp();
        }

        // Quick-jump: 1-9, 0, a-z (skipping reserved keys) opens workspace directly
        if (key.sequence && key.sequence.length === 1 && !RESERVED_DASH_KEYS.has(key.sequence)) {
          const num = indexForJumpKey(key.sequence);
          if (num >= 0 && num < state.filteredWorkspaces.length) {
            state.cursor = num;
            showView("detail");
            state.scrollOffset = -1; // follow bottom on entry
            state.lastDetailRefresh = Date.now();
            state.screenLines = await fetchScreen(state.filteredWorkspaces[state.cursor]!.ref);
            renderDetail();
          }
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
        } else if (isCtrl && key.name === "u") {
          // Ctrl+U → scroll up half page
          const visibleLines = Math.min(H - 5, MAX_SCREEN_LINES);
          const halfPage = Math.max(1, Math.floor(visibleLines / 2));
          state.scrollOffset = Math.max(0, state.scrollOffset - halfPage);
          renderDetail();
        } else if (isCtrl && key.name === "d") {
          // Ctrl+D → scroll down half page
          const visibleLines = Math.min(H - 5, MAX_SCREEN_LINES);
          const halfPage = Math.max(1, Math.floor(visibleLines / 2));
          const maxScroll = Math.max(0, state.screenLines.length - visibleLines);
          state.scrollOffset = Math.min(maxScroll, state.scrollOffset + halfPage);
          renderDetail();
        } else if (key.name === "pageup") {
          // Page Up → scroll up full page
          const visibleLines = Math.min(H - 5, MAX_SCREEN_LINES);
          state.scrollOffset = Math.max(0, state.scrollOffset - visibleLines);
          renderDetail();
        } else if (key.name === "pagedown") {
          // Page Down → scroll down full page
          const visibleLines = Math.min(H - 5, MAX_SCREEN_LINES);
          const maxScroll = Math.max(0, state.screenLines.length - visibleLines);
          state.scrollOffset = Math.min(maxScroll, state.scrollOffset + visibleLines);
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
            // Save to history (avoid duplicating last entry)
            const cmd = state.inputBuffer.trim();
            if (state.inputHistory[state.inputHistory.length - 1] !== cmd) {
              state.inputHistory.push(cmd);
              // Keep max 50 entries
              if (state.inputHistory.length > 50) state.inputHistory.shift();
            }
            await cmux("send", "--workspace", ws.ref, state.inputBuffer);
            await cmux("send-key", "--workspace", ws.ref, "Enter");
            state.inputBuffer = "";
            state.historyIndex = -1;
          } else {
            await cmux("send-key", "--workspace", ws.ref, "Enter");
          }
          await Bun.sleep(300);
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = Date.now();
          renderDetail();
        } else if (key.name === "left") {
          // ← → previous workspace
          if (state.cursor > 0) {
            state.cursor--;
            state.inputBuffer = "";
            state.historyIndex = -1;
            state.scrollOffset = -1; // follow bottom on new workspace
            state.lastDetailRefresh = Date.now();
            state.screenLines = await fetchScreen(state.filteredWorkspaces[state.cursor]!.ref);
            renderDetail();
          }
        } else if (key.name === "right") {
          // → → next workspace
          if (state.cursor < state.filteredWorkspaces.length - 1) {
            state.cursor++;
            state.inputBuffer = "";
            state.historyIndex = -1;
            state.scrollOffset = -1; // follow bottom on new workspace
            state.lastDetailRefresh = Date.now();
            state.screenLines = await fetchScreen(state.filteredWorkspaces[state.cursor]!.ref);
            renderDetail();
          }
        } else if (key.name === "up") {
          // ↑ → browse input history (older)
          if (state.inputHistory.length > 0) {
            if (state.historyIndex < state.inputHistory.length - 1) {
              state.historyIndex++;
            }
            state.inputBuffer = state.inputHistory[state.inputHistory.length - 1 - state.historyIndex] ?? "";
            renderDetail();
          }
        } else if (key.name === "down") {
          // ↓ → browse input history (newer)
          if (state.historyIndex > 0) {
            state.historyIndex--;
            state.inputBuffer = state.inputHistory[state.inputHistory.length - 1 - state.historyIndex] ?? "";
          } else {
            state.historyIndex = -1;
            state.inputBuffer = "";
          }
          renderDetail();
        } else if (key.name === "backspace" || key.name === "delete") {
          state.inputBuffer = state.inputBuffer.slice(0, -1);
          state.historyIndex = -1;
          renderDetail();
        } else if (key.name === "tab") {
          // Tab → send tab to workspace (useful for autocomplete)
          await cmux("send-key", "--workspace", ws.ref, "Tab");
          await Bun.sleep(200);
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = Date.now();
          renderDetail();
        } else if (key.sequence === "?") {
          // ? → help overlay
          showView("help");
          renderHelp();
        } else if (key.sequence && key.sequence.length === 1 && key.sequence.charCodeAt(0) >= 32) {
          // Printable character → add to input buffer
          state.inputBuffer += key.sequence;
          state.historyIndex = -1;
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

      } else if (state.view === "help") {
        // Any key returns from help
        if (key.name === "escape" || key.name === "return" || key.sequence === "?" || key.sequence === "q") {
          showView("dashboard");
          renderDashboard();
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
          // Check if user was at bottom before refresh
          const visibleLines = Math.min(H - 5, MAX_SCREEN_LINES);
          const wasAtBottom = state.scrollOffset >= Math.max(0, state.screenLines.length - visibleLines);
          state.screenLines = await fetchScreen(ws.ref);
          state.lastDetailRefresh = now;
          // If user was at bottom (or following), keep following
          if (wasAtBottom) {
            state.scrollOffset = -1; // follow bottom
          }
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
