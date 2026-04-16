#!/bin/bash
# Transfer all memory entries from one ruflo instance to another via MCP/SSE HTTP API
# Usage: ./transfer-memory.sh [source_port] [dest_port]

SOURCE_PORT="${1:-3200}"
DEST_PORT="${2:-3201}"
SOURCE="http://localhost:${SOURCE_PORT}"
DEST="http://localhost:${DEST_PORT}"

echo "=== Ruflo Memory Transfer ==="
echo "Source: $SOURCE"
echo "Dest:   $DEST"
echo ""

# Function to create SSE session and get session ID
get_session() {
  local base_url="$1"
  # Start SSE connection in background, grab the session endpoint from the first event
  local session_url
  session_url=$(curl -s -N "${base_url}/sse" 2>/dev/null &
    CURL_PID=$!
    # Read the first SSE event which contains the session endpoint
    sleep 2
    kill $CURL_PID 2>/dev/null
  )
  # Alternative: just use the /message endpoint with a fresh session each time
  echo ""
}

# Function to call MCP tool via JSON-RPC
call_mcp() {
  local base_url="$1"
  local session_id="$2"
  local method="$3"
  local params="$4"
  local msg_id="$5"

  curl -s -X POST "${base_url}/message?sessionId=${session_id}" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":${msg_id},\"method\":\"${method}\",\"params\":${params}}"
}

# Step 1: Connect to source, init session
echo "[1/4] Connecting to source ($SOURCE)..."
# Get SSE session - parse endpoint from SSE stream
SOURCE_SSE_RESP=$(timeout 3 curl -s -N "${SOURCE}/sse" 2>/dev/null || true)
SOURCE_SESSION=$(echo "$SOURCE_SSE_RESP" | grep -oP 'sessionId=\K[^&"\s]+' | head -1)

if [ -z "$SOURCE_SESSION" ]; then
  echo "ERROR: Could not get source session. Trying alternative method..."
  # Some versions return the endpoint differently
  SOURCE_SESSION=$(echo "$SOURCE_SSE_RESP" | grep -oP '[a-f0-9-]{36}' | head -1)
fi

if [ -z "$SOURCE_SESSION" ]; then
  echo "ERROR: Failed to connect to source. Response:"
  echo "$SOURCE_SSE_RESP" | head -5
  exit 1
fi
echo "  Source session: $SOURCE_SESSION"

# Step 2: Connect to dest
echo "[2/4] Connecting to dest ($DEST)..."
DEST_SSE_RESP=$(timeout 3 curl -s -N "${DEST}/sse" 2>/dev/null || true)
DEST_SESSION=$(echo "$DEST_SSE_RESP" | grep -oP 'sessionId=\K[^&"\s]+' | head -1)

if [ -z "$DEST_SESSION" ]; then
  DEST_SESSION=$(echo "$DEST_SSE_RESP" | grep -oP '[a-f0-9-]{36}' | head -1)
fi

if [ -z "$DEST_SESSION" ]; then
  echo "ERROR: Failed to connect to dest. Response:"
  echo "$DEST_SSE_RESP" | head -5
  exit 1
fi
echo "  Dest session: $DEST_SESSION"

# Step 3: Initialize both sessions
echo "[3/4] Initializing MCP sessions..."

# Init source
curl -s -X POST "${SOURCE}/message?sessionId=${SOURCE_SESSION}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"transfer-script","version":"1.0"}}}' > /dev/null

curl -s -X POST "${SOURCE}/message?sessionId=${SOURCE_SESSION}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

# Init dest
curl -s -X POST "${DEST}/message?sessionId=${DEST_SESSION}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"transfer-script","version":"1.0"}}}' > /dev/null

curl -s -X POST "${DEST}/message?sessionId=${DEST_SESSION}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

sleep 1

# Step 4: List all memory from source, retrieve and store in dest
echo "[4/4] Transferring memory entries..."

OFFSET=0
LIMIT=50
TOTAL=0
TRANSFERRED=0
FAILED=0
MSG_ID=1

while true; do
  # List entries from source
  MSG_ID=$((MSG_ID + 1))
  LIST_RESPONSE=$(curl -s -X POST "${SOURCE}/message?sessionId=${SOURCE_SESSION}" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":${MSG_ID},\"method\":\"tools/call\",\"params\":{\"name\":\"memory_list\",\"arguments\":{\"limit\":${LIMIT},\"offset\":${OFFSET}}}}")

  sleep 1

  # Read the SSE response
  LIST_DATA=$(timeout 3 curl -s -N "${SOURCE}/sse" 2>/dev/null || true)

  # We need a different approach - the response comes via SSE, not via POST response
  # Let's use a temp file to capture SSE events
  TMPFILE=$(mktemp)

  # Actually with supergateway, POST returns immediately and response comes via SSE
  # Let's try reading from the SSE stream that's already connected

  echo "  Batch at offset $OFFSET..."

  # Use python for proper JSON handling
  python3 << 'PYEOF'
import json
import urllib.request
import sys
import time
import ssl
import http.client

SOURCE = "http://localhost:SOURCE_PORT_PLACEHOLDER"
DEST = "http://localhost:DEST_PORT_PLACEHOLDER"

def mcp_call(base_url, session_id, tool_name, arguments, msg_id):
    """Call an MCP tool and return result. With supergateway SSE, we need to handle async."""
    url = f"{base_url}/message?sessionId={session_id}"
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": msg_id,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments
        }
    }).encode()

    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return resp.read().decode()
    except Exception as e:
        return str(e)

# This approach won't work well with SSE - the response comes asynchronously
print("Python helper: SSE-based MCP requires async handling, exiting.")
sys.exit(1)
PYEOF

  break  # Exit bash loop, we need a better approach
done

echo ""
echo "=== Need a different approach for SSE-based MCP ==="
echo "Use the Node.js transfer script instead."
