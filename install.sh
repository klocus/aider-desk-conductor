#!/bin/bash

set -e

REPO_URL="https://github.com/klocus/aider-desk-conductor/archive/refs/heads/master.zip"
TEMP_DIR=$(mktemp -d)
TRAP_CLEANUP() { rm -rf "$TEMP_DIR"; }
trap TRAP_CLEANUP EXIT

echo "Downloading AiderDesk Conductor extension..."
cd "$TEMP_DIR"

if command -v curl &> /dev/null; then
    curl -fsSL "$REPO_URL" -o repo.zip
elif command -v wget &> /dev/null; then
    wget -q "$REPO_URL" -O repo.zip
else
    echo "Error: Neither curl nor wget is installed."
    exit 1
fi

echo "Extracting..."
unzip -q repo.zip

SCRIPT_DIR="aider-desk-conductor-master"

# Ask user for installation type
echo ""
echo "Conductor Extension Installer"
echo "=============================="
echo ""
echo "Choose installation type:"
echo "  1) Local  (\$PWD/.aider-desk/extensions)"
echo "  2) Global (\$HOME/.aider-desk/extensions)"
echo ""
read -p "Enter choice [1-2]: " choice

# Determine target directory
case $choice in
    1)
        TARGET_DIR="$PWD/.aider-desk/extensions"
        echo ""
        echo "Installing locally..."
        ;;
    2)
        TARGET_DIR="$HOME/.aider-desk/extensions"
        echo ""
        echo "Installing globally..."
        ;;
    *)
        echo "Invalid choice. Please run the script again and enter 1 or 2."
        exit 1
        ;;
esac

# Create extensions directory
mkdir -p "$TARGET_DIR"

# Copy conductor directory
echo "Copying conductor extension..."
CONDUCTOR_DIR="$TEMP_DIR/$SCRIPT_DIR/conductor"
if [ ! -d "$CONDUCTOR_DIR" ]; then
    echo "Error: conductor directory not found in downloaded archive."
    exit 1
fi

if [ -d "${TARGET_DIR}/conductor" ]; then
    echo "Existing conductor extension found. Removing..."
    rm -rf "${TARGET_DIR}/conductor"
fi

cp -R "$CONDUCTOR_DIR" "${TARGET_DIR}/"

# Success message
echo ""
echo "✓ Conductor extension installed successfully!"
echo "  Location: ${TARGET_DIR}/conductor"
echo ""
echo "Restart AiderDesk to see the extension."
