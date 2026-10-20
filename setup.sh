#!/bin/sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}[1/6] Updating packages...${NC}"
apk update && echo -e "${GREEN}[1/6] Update complete${NC}"

echo -e "${BLUE}[2/6] Upgrading packages...${NC}"
apk upgrade && echo -e "${GREEN}[2/6] Upgrade complete${NC}"

echo -e "${BLUE}[3/6] Checking required tools...${NC}"
for pkg in bash gcompat util-linux parted ddrescue; do
    if apk info -e "$pkg" > /dev/null 2>&1; then
        echo -e "${GREEN}[3/6] $pkg is already installed${NC}"
    else
        echo -e "${YELLOW}[3/6] $pkg not found${NC}"
        echo -e "${BLUE}[3/6] Installing $pkg...${NC}"
        apk add "$pkg" && echo -e "${GREEN}[3/6] $pkg installed successfully${NC}"
    fi
done

echo -e "${BLUE}[4/6] Checking nodejs...${NC}"
if command -v node &> /dev/null; then
    echo -e "${GREEN}[4/6] nodejs is already installed${NC}"
else
    echo -e "${YELLOW}[4/6] nodejs not found${NC}"
    echo -e "${BLUE}[4/6] Installing nodejs...${NC}"
    apk add nodejs && echo -e "${GREEN}[4/6] nodejs installed successfully${NC}"
fi

echo -e "${BLUE}[5/6] Checking wget...${NC}"
if command -v wget &> /dev/null; then
    echo -e "${GREEN}[5/6] wget is already installed${NC}"
else
    echo -e "${YELLOW}[5/6] wget not found${NC}"
    echo -e "${BLUE}[5/6] Installing wget...${NC}"
    apk add wget && echo -e "${GREEN}[5/6] wget installed successfully${NC}"
fi

echo -e "${BLUE}[6/6] Downloading latest Ventoy release...${NC}"
VENTOY_URL=$(wget -qO- https://api.github.com/repos/ventoy/Ventoy/releases/latest \
    | grep "browser_download_url.*linux.tar.gz" \
    | cut -d '"' -f 4)
if [ -z "$VENTOY_URL" ]; then
    echo -e "${RED}Failed to fetch Ventoy release URL${NC}"
    exit 1
fi
wget -c -O ventoy-latest.tar.gz "$VENTOY_URL" \
    && echo -e "${GREEN}[6/6] Ventoy downloaded successfully${NC}"

echo -e "${BLUE}[6/6] Extracting Ventoy archive...${NC}"

tar -xzf ventoy-latest.tar.gz -C .

EXTRACTED_DIR=$(find . -maxdepth 1 -type d -name 'ventoy-*' ! -name 'ventoy' | head -1)

if [ -n "$EXTRACTED_DIR" ]; then
    rm -rf ventoy ventoy-latest.tar.gz
    mv "$EXTRACTED_DIR" ventoy
fi

echo -e "${GREEN}[6/6] Ventoy extracted and renamed to 'ventoy'${NC}"

echo -e "${GREEN}All done.${NC}"
