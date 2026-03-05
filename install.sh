#!/bin/bash

set -e

REPO_URL="https://github.com/klocus/aider-desk-conductor/archive/refs/heads/master.zip"
ORIGINAL_DIR="$PWD"
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

# Parse arguments
TARGET_DIR=""

if [ "$1" = "--global" ] || [ "$1" = "-g" ]; then
    TARGET_DIR="$HOME/.aider-desk/extensions"
    echo "Installing globally..."
else
    # Default: local installation
    TARGET_DIR="$ORIGINAL_DIR/.aider-desk/extensions"
    echo "Installing locally..."
fi

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
echo "Select the Conductor agent to use this extension."
