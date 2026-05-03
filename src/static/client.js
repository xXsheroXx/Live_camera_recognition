const video = document.getElementById("video");
const canvas = document.getElementById("overlay");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

let pc = null;
let channel = null;
let stream = null;
let lastDetections = [];
let drawLoopRunning = false;

function setStatus(text, isWarn = false) {
  statusEl.textContent = text;
  statusEl.style.color = isWarn ? "#ffb454" : "#4bd37b";
}

function resizeCanvas() {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  canvas.width = width;
  canvas.height = height;
}

function drawDetections() {
  if (!drawLoopRunning) {
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 2;
  ctx.font = "16px ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif";

  for (const det of lastDetections) {
    const [x1, y1, x2, y2] = det.box;
    const w = x2 - x1;
    const h = y2 - y1;

    ctx.strokeStyle = "#4bd37b";
    ctx.strokeRect(x1, y1, w, h);

    const label = `${det.label} ${(det.confidence * 100).toFixed(1)}%`;
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(x1, y1 - 20, textWidth + 8, 20);
    ctx.fillStyle = "#e7eef7";
    ctx.fillText(label, x1 + 4, y1 - 5);
  }

  requestAnimationFrame(drawDetections);
}

function waitForIceGatheringComplete(peer) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    function checkState() {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener("icegatheringstatechange", checkState);
        resolve();
      }
    }
    peer.addEventListener("icegatheringstatechange", checkState);
  });
}

async function start() {
  startBtn.disabled = true;
  setStatus("Requesting camera...", true);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;

    await new Promise((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    resizeCanvas();
    drawLoopRunning = true;
    requestAnimationFrame(drawDetections);

    pc = new RTCPeerConnection();
    channel = pc.createDataChannel("detections");

    channel.onopen = () => setStatus("Data channel open");
    channel.onclose = () => setStatus("Data channel closed", true);
    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "detections") {
          lastDetections = msg.items || [];
        }
      } catch (err) {
        console.warn("Bad message", err);
      }
    };

    pc.oniceconnectionstatechange = () => {
      setStatus(`ICE ${pc.iceConnectionState}`, pc.iceConnectionState !== "connected");
    };

    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    const response = await fetch("/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp: pc.localDescription.sdp,
        type: pc.localDescription.type
      })
    });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    const answer = await response.json();
    await pc.setRemoteDescription(answer);

    setStatus("Connected");
    stopBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus("Failed to start", true);
    startBtn.disabled = false;
  }
}

async function stop() {
  stopBtn.disabled = true;

  if (channel) {
    channel.close();
    channel = null;
  }

  if (pc) {
    pc.close();
    pc = null;
  }

  if (stream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    stream = null;
  }

  lastDetections = [];
  drawLoopRunning = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  setStatus("Stopped", true);
  startBtn.disabled = false;
}

startBtn.addEventListener("click", start);
stopBtn.addEventListener("click", stop);
window.addEventListener("resize", resizeCanvas);
