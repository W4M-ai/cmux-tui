#!/usr/bin/env bash
# cmux-tui installer
# Installs cmux-tui and makes it available in your PATH

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

INSTALL_DIR="${HOME}/.cmux-tui"
BIN_DIR="${HOME}/.local/bin"
REPO_URL="https://github.com/W4M-ai/cmux-tui.git"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  cmux-tui installer${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Helper functions
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

install_bun() {
    echo -e "${YELLOW}⚠  Bun not found. Installing...${NC}"
    if command_exists brew; then
        brew install bun
    else
        curl -fsSL https://bun.sh/install | bash
    fi
    export PATH="${HOME}/.bun/bin:$PATH"
}

check_bun() {
    if ! command_exists bun; then
        echo -e "${YELLOW}Bun required but not found.${NC}"
        read -p "Install Bun? (y/n) " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            install_bun
        else
            echo -e "${RED}✗ Bun is required to run cmux-tui${NC}"
            exit 1
        fi
    fi
    echo -e "${GREEN}✓ Bun found: $(bun --version)${NC}"
}

check_cmux() {
    if ! command_exists cmux; then
        echo -e "${YELLOW}⚠  cmux CLI not found in PATH${NC}"
        echo -e "   Note: cmux is required at runtime. Install from: https://github.com/W4M-ai/cmux"
    else
        echo -e "${GREEN}✓ cmux CLI found${NC}"
    fi
}

clone_or_update() {
    if [[ -d "$INSTALL_DIR" ]]; then
        echo -e "${BLUE}→ Updating existing installation...${NC}"
        cd "$INSTALL_DIR"
        git pull origin main 2>/dev/null || echo -e "${YELLOW}  (Not a git repo, skipping pull)${NC}"
    else
        echo -e "${BLUE}→ Cloning repository...${NC}"
        git clone "$REPO_URL" "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
}

install_dependencies() {
    echo -e "${BLUE}→ Installing dependencies with Bun...${NC}"
    bun install
}

create_symlinks() {
    mkdir -p "$BIN_DIR"
    
    # Make scripts executable
    chmod +x "$INSTALL_DIR/bin/cmux-tui.sh"
    chmod +x "$INSTALL_DIR/bin/cx"
    
    # Create symlinks
    ln -sf "$INSTALL_DIR/bin/cmux-tui.sh" "$BIN_DIR/cmux-tui"
    ln -sf "$INSTALL_DIR/bin/cx" "$BIN_DIR/cx"
    
    echo -e "${GREEN}✓ Symlinks created in ${BIN_DIR}${NC}"
}

check_path() {
    if [[ ":$PATH:" == *":${BIN_DIR}:"* ]]; then
        echo -e "${GREEN}✓ ${BIN_DIR} is in PATH${NC}"
    else
        echo -e "${YELLOW}⚠  ${BIN_DIR} not in PATH${NC}"
        echo -e "   Add this to your shell config (~/.bashrc, ~/.zshrc, etc.):"
        echo -e "   ${BLUE}export PATH=\"${BIN_DIR}:\$PATH\"${NC}"
    fi
}

set_env_var() {
    if [[ -z "${CMUX_SOCKET_PASSWORD:-}" ]]; then
        echo ""
        echo -e "${YELLOW}⚠  CMUX_SOCKET_PASSWORD not set${NC}"
        echo -e "   This env var is required to authenticate with cmux."
        echo -e "   Set it in your shell config or with:"
        echo -e "   ${BLUE}export CMUX_SOCKET_PASSWORD='<your-password>'${NC}"
    else
        echo -e "${GREEN}✓ CMUX_SOCKET_PASSWORD is set${NC}"
    fi
}

# Main installation flow
check_bun
check_cmux
clone_or_update
install_dependencies
create_symlinks
check_path
set_env_var

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Installation complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Next steps:"
echo "  1. Ensure ~/.local/bin is in your PATH"
echo "  2. Set CMUX_SOCKET_PASSWORD environment variable"
echo "  3. Run 'cmux-tui' to start the TUI"
echo "  4. Or use 'cx help' for the lightweight CLI"
echo ""
