# cmux-tui

A terminal UI for remotely controlling [cmux](https://cmux.com) workspaces over SSH, designed for managing Claude Code sessions from an iPad or iPhone.

Manage your development environments from anywhere with a lightweight, responsive TUI built with [OpenTUI](https://opentui.dev) and [Bun](https://bun.com).

---

## Features

**Dashboard View**
- List all cmux workspaces with live status indicators
- Color-coded status: ⚡ Running, ⏳ Needs Input, ○ Idle
- Auto-refresh every 5 seconds
- Clean, keyboard-driven navigation

**Detail View**
- Read terminal screen content from any workspace
- See what's currently running in real-time

**Input Mode**
- Type and send commands to any workspace remotely
- Full keyboard support from SSH terminal

**Focus Control**
- Switch which workspace is active on your Mac's display
- Seamlessly manage multiple projects

---

## Quick Start

### Prerequisites

- **macOS** with [cmux installed](https://cmux.com/download)
- **Bun** runtime ([install Bun](https://bun.sh))
- **SSH server** enabled on your Mac
  - System Settings → General → Sharing → Remote Login → Enable
- **cmux configured** for remote access (see [Socket Authentication](#socket-authentication))
- **CMUX_SOCKET_PASSWORD** environment variable set

### Installation

**Automated:**
```bash
curl -fsSL https://raw.githubusercontent.com/W4M-ai/cmux-tui/main/install.sh | bash
```

**Manual:**
```bash
git clone https://github.com/W4M-ai/cmux-tui.git ~/.cmux-tui
cd ~/.cmux-tui
bun install

# Add to PATH
echo 'export PATH="$HOME/.cmux-tui:$PATH"' >> ~/.zshenv

# Set password (required)
echo 'export CMUX_SOCKET_PASSWORD="your-password"' >> ~/.zshenv

# Reload shell
source ~/.zshenv
```

### Running

**TUI Dashboard:**
```bash
cmux-tui
```

**Quick CLI Commands (cx helper):**
```bash
cx                    # List all workspaces
cx tree               # Show full session tree
cx status             # Display workspace statuses
cx focus myworkspace  # Switch active workspace
cx read myworkspace   # Read workspace screen content
cx run myworkspace "ls -la"  # Send command to workspace
```

---

## How It Works

```
┌─────────────┐
│  iPad/Phone │
│  SSH Client │
└──────┬──────┘
       │ SSH Connection
       │ Port 22
       ▼
┌─────────────────────────────┐
│   Your Mac               │
│                         │
│  ┌──────────────────┐  │
│  │   cmux-tui       │  │
│  │  (TUI Dashboard) │  │
│  └────────┬─────────┘  │
│           │            │
│           │ Unix Socket│
│           │ (encrypted)│
│  ┌────────▼─────────┐  │
│  │      cmux        │  │
│  │  (Workspaces &   │  │
│  │   Claude Code)   │  │
│  └──────────────────┘  │
│                         │
└─────────────────────────────┘
```

**The architecture:**

1. **TUI runs on your Mac** – cmux-tui is a native OpenTUI application running locally
2. **You SSH in from mobile** – Connect from iPad/iPhone using any SSH client
3. **Secure socket communication** – TUI talks to cmux via a password-protected Unix socket
4. **Real-time workspace control** – Send commands, switch focus, monitor status in real-time

---

## Socket Authentication

To allow SSH sessions to control cmux remotely, you must enable password-protected socket access:

1. **Open cmux Settings** on your Mac
2. **Scroll to "Automation" section**
3. **Change "Socket Control Mode"** from "cmux processes only" to "Password mode"
4. **Set a password** and save it
5. **Export the password** in your shell:
   ```bash
   export CMUX_SOCKET_PASSWORD="your-password"
   ```
   Add this to `~/.zshenv` (or `~/.bash_profile` for bash) to persist it.

**Why this is needed:** By default, cmux only allows processes started inside cmux to connect to its socket. Password mode allows external processes (like your SSH session) to authenticate and connect.

---

## Key Bindings

### Dashboard Navigation

| Key | Action |
|-----|--------|
| `j` / `↓` | Move cursor down |
| `k` / `↑` | Move cursor up |
| `Enter` | Drill into workspace detail |
| `Esc` | Go back to dashboard |
| `i` | Enter input mode (send commands) |
| `f` | Focus selected workspace on Mac |
| `r` | Refresh workspace list |
| `q` | Quit application |

### Input Mode

| Key | Action |
|-----|--------|
| Type text | Enter command |
| `Enter` | Send command to workspace |
| `Ctrl+C` | Cancel input |
| `Esc` | Exit input mode |

### Detail View

| Key | Action |
|-----|--------|
| `↑` / `↓` | Scroll through content |
| `r` | Refresh screen content |
| `Esc` | Return to dashboard |

---

## iOS SSH Tips

### Terminal Apps

We recommend these SSH clients for iOS:

- **[Blink Shell](https://blinkshell.com/)** – Feature-rich, customizable, great keyboard support
- **[Termius](https://www.termius.com/)** – User-friendly, good UI, cross-platform
- **Prompt 3** – Well-designed, popular among developers

### Escape Key

The Escape key is critical for cmux-tui navigation. In most iOS terminal apps:

```
Escape = Ctrl + [
```

Configure your SSH app to map `Escape` to `Ctrl+[` if not already set.

### Terminal Width Adaptation

cmux-tui automatically adapts to your terminal width:

- **iPhone** (narrow ~40 columns) – Compact view, abbreviated status
- **iPad** (wide ~80+ columns) – Full dashboard with detailed information

Rotate your device to adjust the layout in real-time.

### Connection Tips

- **Keep-alive:** Enable SSH keep-alive in your terminal app settings to prevent disconnections
- **Font size:** Use a monospace font at 11-13pt for readability
- **Auto-lock:** Configure your iOS device to not auto-lock while using SSH
- **Clipboard:** Most terminal apps support clipboard paste via long-press

---

## Troubleshooting

### Socket Connection Failed

```
Error: Unable to connect to cmux socket
```

**Check:**
1. `echo $CMUX_SOCKET_PASSWORD` – Is the password exported?
2. cmux Settings → Automation → Socket Control Mode is set to "Password mode"
3. cmux is actually running on your Mac
4. Try `cx status` to test the connection

### Commands Not Executing

```
Error: Timeout sending command to workspace
```

**Check:**
1. Is the workspace actually running? (Check `cx tree`)
2. Does the workspace need input? (Status shows ⏳ Needs Input)
3. Try sending a simple command first: `cx run myworkspace "echo test"`

### SSH Connection Drops

1. Enable keep-alive in your SSH client settings
2. Check that your iOS device isn't auto-locking
3. Try SSHing in again with `-v` flag for verbose debugging

### Port 22 Not Accessible

```
ssh: connect to host example.com port 22: Connection refused
```

**On your Mac:**
1. System Settings → General → Sharing
2. Scroll to "Remote Login"
3. Click the toggle to enable it
4. Note your hostname: `System Settings → General → About → Local Hostname`

To SSH in: `ssh username@hostname.local`

---

## Two Tools

### 1. cmux-tui (TUI Dashboard)

The main interactive dashboard for managing workspaces.

```bash
cmux-tui
```

Features:
- Real-time workspace overview
- Interactive navigation
- Live screen content viewing
- Remote command execution
- Workspace focus control

### 2. cx (CLI Helper)

Quick command-line tool for scripting and one-off operations.

```bash
cx              # List workspaces
cx tree         # Full session tree
cx status       # All workspace statuses
cx focus NAME   # Switch workspace (fuzzy match)
cx read NAME    # Read workspace screen
cx run NAME CMD # Send command (fuzzy match)
```

All `cx` commands support fuzzy matching on workspace names, so you don't need the exact name.

---

## Tech Stack

- **OpenTUI** – Zig-native terminal UI framework
- **Bun** – JavaScript runtime and package manager
- **TypeScript** – Type-safe implementation

---

## Development

### Setup

```bash
git clone https://github.com/W4M-ai/cmux-tui.git
cd cmux-tui
bun install
```

### Run (Development Mode)

```bash
bun --hot ./index.ts
```

This enables hot reloading for faster development.

### Build

```bash
bun build ./index.ts
```

### Test

```bash
bun test
```

---

## Contributing

We welcome contributions! Whether it's bug reports, feature suggestions, or code improvements:

1. **Fork** the repository
2. **Create a feature branch:** `git checkout -b feature/amazing-feature`
3. **Commit your changes:** `git commit -m 'Add amazing feature'`
4. **Push to the branch:** `git push origin feature/amazing-feature`
5. **Open a Pull Request**

### Code Style

- Use TypeScript for type safety
- Follow the Bun conventions (prefer Bun APIs over Node.js)
- Keep components focused and testable
- Add tests for new features

### Reporting Bugs

Please include:
- Your macOS version
- Your cmux version
- Terminal app and iOS version (if applicable)
- Steps to reproduce
- Expected vs. actual behavior

---

## License

MIT License – see [LICENSE](LICENSE) file for details.

---

## Resources

- [cmux Documentation](https://cmux.com)
- [Bun Documentation](https://bun.sh/docs)
- [OpenTUI Documentation](https://opentui.dev)
- [GitHub Repository](https://github.com/W4M-ai/cmux-tui)

---

## Acknowledgments

Built for Claude Code users who manage projects from anywhere.

Have questions? Open an issue on [GitHub](https://github.com/W4M-ai/cmux-tui/issues).
