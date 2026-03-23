let pc;
let channel;
let receivedChunks = [];
let receivedBytes  = 0;
let incomingFileInfo = null;

const CHUNK_SIZE = 16 * 1024;

// ── ICE servers ───────────────────────────────────────────────────────────────
// STUN = discovers your public IP (fast, no relay)
// TURN = relays traffic through a server (slower but works on corporate networks)
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80",               username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:80?transport=tcp",  username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",               username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:openrelay.metered.ca:443?transport=tcp",username: "openrelayproject", credential: "openrelayproject" }
];

// ── Compress / decompress SDP for copy-paste ──────────────────────────────────
function compress(data) {
  const json = JSON.stringify(data);
  return btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,
    (_, p1) => String.fromCharCode(parseInt(p1, 16))));
}
function decompress(data) {
  return JSON.parse(decodeURIComponent(
    atob(data).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2,"0")).join("")));
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function log(msg, type) {
  const box = document.getElementById("logBox");
  if (!box) return;
  const div = document.createElement("div");
  div.className = "log-" + (type || "info");
  div.textContent = "[" + new Date().toLocaleTimeString("en-US", { hour12: false }) + "] " + msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setStatus(text, type) {
  const dot  = document.getElementById("statusDot");
  const span = document.getElementById("statusText");
  const sb   = document.getElementById("sbStatus");
  if (dot)  dot.className   = "dot dot-" + (type || "idle");
  if (span) span.textContent = text;
  if (sb)   sb.textContent   = text;
}

function setTransferControlsEnabled(on) {
  ["chatInput", "sendMsgBtn", "sendFileBtn", "fileInput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

// BUG FIX 4: disable/enable connection buttons during async operations
// so two peers can't be created at once
function setConnectionBtnsEnabled(on) {
  ["btnCreateOffer", "btnGenAnswer", "btnConnect"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function fmtBytes(b) {
  if (b < 1024)    return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function flash(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = orig, 1500);
}

// ── Peer connection ───────────────────────────────────────────────────────────
function createPeer() {
  if (pc) { pc.close(); pc = null; }
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceTransportPolicy: "all" });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const labels = {
      connected: "Connected", connecting: "Connecting…",
      disconnected: "Disconnected", failed: "Connection failed",
      closed: "Closed", new: "Initialising…"
    };
    const types = {
      connected: "connected", connecting: "connecting", new: "connecting",
      disconnected: "error", failed: "error", closed: "idle"
    };
    log("Connection state: " + s, s === "connected" ? "ok" : s === "failed" ? "err" : "info");
    setStatus(labels[s] || s, types[s] || "idle");
    setTransferControlsEnabled(s === "connected");
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      log("ICE candidate: " + (e.candidate.type || "?") + " via " + (e.candidate.protocol || "?"));
    }
  };

  pc.onicecandidateerror = (e) => {
    // 701 = TURN auth failed for a server — not fatal, browser tries others
    if (e.errorCode !== 701) log("ICE error " + e.errorCode + ": " + e.errorText, "warn");
  };

  // ondatachannel fires on the answerer side when Peer A's channel is received
  pc.ondatachannel = (e) => { channel = e.channel; setupChannel(); };
}

// ── Data channel ──────────────────────────────────────────────────────────────
function setupChannel() {
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    log("Channel open — ready to chat and transfer files!", "ok");
    setStatus("Connected", "connected");
    setTransferControlsEnabled(true);
    setConnectionBtnsEnabled(true);
  };

  channel.onclose = () => {
    log("Channel closed.", "warn");
    setStatus("Disconnected", "idle");
    setTransferControlsEnabled(false);
    setConnectionBtnsEnabled(true);
  };

  channel.onerror = (e) => {
    log("Channel error: " + (e.message || "unknown"), "err");
    setStatus("Error", "error");
    setConnectionBtnsEnabled(true);
  };

  channel.onmessage = (e) => {
    if (typeof e.data === "string") {
      if (e.data.startsWith("MSG:")) {
        addChat("peer", e.data.slice(4));
        return;
      }
      if (e.data.startsWith("META:")) {
        incomingFileInfo = JSON.parse(e.data.slice(5));
        receivedChunks = []; receivedBytes = 0;
        log("Incoming file: " + incomingFileInfo.name + " (" + fmtBytes(incomingFileInfo.size) + ")");
        updateProgress(0, "Receiving…");
        return;
      }
      if (e.data === "EOF") { finalizeDownload(); return; }
    }
    if (e.data instanceof ArrayBuffer) {
      receivedChunks.push(e.data);
      receivedBytes += e.data.byteLength;
      if (incomingFileInfo)
        updateProgress(Math.min(100, (receivedBytes / incomingFileInfo.size) * 100), "Receiving…");
    }
  };
}

// ── Offer / Answer ────────────────────────────────────────────────────────────
async function createOffer() {
  try {
    setConnectionBtnsEnabled(false); // BUG FIX 4: lock buttons during generation
    setStatus("Gathering candidates…", "connecting");
    log("Creating offer…");
    createPeer();
    channel = pc.createDataChannel("file");
    setupChannel();
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(); // BUG FIX 2: now uses smart 2s timeout (was 10s)
    document.getElementById("offerBox").value = compress(pc.localDescription);
    log("Offer ready — copy it and send to Peer B.", "ok");
    setStatus("Waiting for Peer B's answer…", "connecting");
    setConnectionBtnsEnabled(true);
  } catch (err) {
    log("Error creating offer: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtnsEnabled(true);
  }
}

async function acceptOffer() {
  try {
    // BUG FIX 1 confirmation: offerBox is plain textarea with no readonly — user can paste freely
    const raw = document.getElementById("offerBox").value.trim();
    if (!raw) { log("Paste Peer A's offer code into the Offer box first!", "warn"); return; }
    setConnectionBtnsEnabled(false); // BUG FIX 4
    setStatus("Generating answer…", "connecting");
    log("Processing offer…");
    createPeer();
    await pc.setRemoteDescription(decompress(raw));
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(); // BUG FIX 2: smart 2s timeout
    document.getElementById("answerBox").value = compress(pc.localDescription);
    log("Answer ready — copy it and send back to Peer A.", "ok");
    setStatus("Waiting for Peer A to connect…", "connecting");
    setConnectionBtnsEnabled(true);
  } catch (err) {
    log("Error generating answer: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtnsEnabled(true);
  }
}

async function acceptAnswer() {
  try {
    const raw = document.getElementById("answerBox").value.trim();
    if (!raw) { log("Paste Peer B's answer code into the Answer box first!", "warn"); return; }
    setConnectionBtnsEnabled(false); // BUG FIX 4
    await pc.setRemoteDescription(decompress(raw));
    log("Answer accepted — establishing connection…", "ok");
    setStatus("Connecting…", "connecting");
    // buttons re-enabled by channel.onopen / onerror / onclose
  } catch (err) {
    log("Error connecting: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtnsEnabled(true);
  }
}

// ── BUG FIX 2: Smart ICE wait ─────────────────────────────────────────────────
// OLD: blindly waited up to 10 seconds for ALL candidates from ALL 6 servers.
// With 4 TURN servers each taking 1-3s, this regularly hit the full 10s timeout.
//
// NEW: resolves as soon as gathering completes OR after 2 seconds max.
// 2 seconds is almost always enough to get at least one STUN + one TURN candidate.
// The browser will continue gathering in the background and the connection still works.
function waitIce() {
  return new Promise((resolve) => {
    // Already done (e.g. if STUN-only and very fast network)
    if (pc.iceGatheringState === "complete") {
      log("ICE gathering complete.");
      resolve();
      return;
    }

    let resolved = false;

    function done(reason) {
      if (resolved) return;
      resolved = true;
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      clearTimeout(timeout);
      log("ICE ready (" + reason + ").");
      resolve();
    }

    // Path 1: gathering genuinely finished
    function onStateChange() {
      if (pc.iceGatheringState === "complete") done("complete");
    }

    // Path 2: we have at least one relay candidate — good enough to connect
    function onCandidate(e) {
      if (e.candidate && e.candidate.type === "relay") done("relay candidate found");
    }

    // Path 3: 2-second safety timeout — proceed with whatever was gathered
    const timeout = setTimeout(() => done("2s timeout, proceeding"), 2000);

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
  });
}

// ── File send ─────────────────────────────────────────────────────────────────
async function sendFile() {
  const file = document.getElementById("fileInput").files[0];
  if (!file) { log("Select a file first.", "warn"); return; }
  if (!channel || channel.readyState !== "open") { log("Not connected.", "err"); return; }

  log("Sending: " + file.name + " (" + fmtBytes(file.size) + ")");
  channel.send("META:" + JSON.stringify({
    name: file.name,
    size: file.size,
    type: file.type || "application/octet-stream"
  }));

  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    if (channel.bufferedAmount > 1_000_000) {
      await new Promise(r => setTimeout(r, 20));
      continue;
    }
    channel.send(buf.slice(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
    updateProgress(Math.min(100, (offset / file.size) * 100), "Sending…");
  }
  channel.send("EOF");
  updateProgress(100, "Sent ✓");
  log("File sent: " + file.name, "ok");
}

// ── File receive ──────────────────────────────────────────────────────────────
function finalizeDownload() {
  const blob = new Blob(receivedChunks, { type: incomingFileInfo?.type || "application/octet-stream" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = incomingFileInfo?.name || "file";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  updateProgress(100, "Received: " + (incomingFileInfo?.name || "file"));
  log("File received: " + (incomingFileInfo?.name || "file"), "ok");
  receivedChunks = []; receivedBytes = 0; incomingFileInfo = null;
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateProgress(pct, label) {
  const p   = Math.min(100, Math.round(pct));
  const bar = document.getElementById("progressBar");
  const lbl = document.getElementById("progressLabel");
  if (bar) bar.style.width = p + "%";
  if (lbl) lbl.textContent = (label ? label + " " : "") + p + "%";
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById("chatInput");
  const msg   = input.value.trim();
  if (!msg) return;
  if (!channel || channel.readyState !== "open") { log("Not connected.", "err"); return; }
  channel.send("MSG:" + msg);
  addChat("you", msg);
  input.value = "";
}

function addChat(who, msg) {
  const box = document.getElementById("chatBox");
  const ph  = box.querySelector(".chat-empty");
  if (ph) ph.remove();
  const row = document.createElement("div");
  row.className = "chat-msg chat-" + who;
  const label = document.createElement("b");
  label.textContent = who === "you" ? "You: " : "Peer: ";
  row.appendChild(label);
  row.appendChild(document.createTextNode(msg));
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ── Copy buttons ──────────────────────────────────────────────────────────────
function copyOffer() {
  const v = document.getElementById("offerBox").value;
  if (v) navigator.clipboard.writeText(v).then(() => flash("copyOfferBtn", "Copied!"));
}
function copyAnswer() {
  const v = document.getElementById("answerBox").value;
  if (v) navigator.clipboard.writeText(v).then(() => flash("copyAnswerBtn", "Copied!"));
}

// ── BUG FIX 3: run init directly — NOT inside DOMContentLoaded ───────────────
// The script tag is at the bottom of <body>, so DOM is already ready.
// window.addEventListener("DOMContentLoaded", ...) never fires if added after
// the event has already occurred, so any init code inside it would never run.
(function init() {
  setTransferControlsEnabled(false);
  setStatus("Not connected", "idle");
  log("PeerDrop 95 ready. Pure peer-to-peer — no server.");
})();

// Enter key sends chat message
document.getElementById("chatInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter") sendMessage();
});